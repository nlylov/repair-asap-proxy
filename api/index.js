// api/index.js (Версия с QStash для Tilda Webhook)

// --- НАЧАЛО: Блок Импортов ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
// Подключаем ПОЛНУЮ рабочую версию googleSheetService (должна быть версия с googleapis)
const { appendLeadToSheet } = require('../lib/googleSheetService');
const { logInfo, logError, logger, logWarn } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { validateLeadData } = require('../lib/utils/validate');
const { Client } = require("@upstash/qstash"); // <--- ДОБАВЛЕН ИМПОРТ QSTASH
// --- КОНЕЦ: Блок Импортов ---

// --- Инициализация Express и OpenAI ---
const app = express();
let openai;
try {
    if (config.openai.apiKey && config.openai.assistantId) {
        openai = new OpenAI({ apiKey: config.openai.apiKey });
        logger.info('OpenAI client initialized successfully.');
    } else {
        throw new Error('OpenAI API Key or Assistant ID is missing in config.');
    }
} catch (error) {
    logger.error('Failed to initialize OpenAI client', error);
}
// ------------------------------------

// --- НАЧАЛО: Блок Middleware ---
app.use((req, res, next) => {
    // Используем существующий x-request-id или генерируем новый
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    // Логируем только если это не запрос от QStash к обработчику очереди (чтобы не дублировать)
    if (!req.originalUrl.includes('/api/process-sheet-queue')) {
       logInfo(req, `${req.method} ${req.originalUrl}`, { headers: req.headers });
    }
    next();
});
app.use(cors(config.cors.options));
app.use(express.json()); // Для парсинга JSON
app.use(express.urlencoded({ extended: true })); // Для парсинга x-www-form-urlencoded

// Обслуживание статических файлов из папки public (относительно папки api)
app.use(express.static(path.join(__dirname, '..', 'public')));
// --- КОНЕЦ: Блок Middleware ---


// --- НАЧАЛО: Блок Роутов --- // API Роуты идут ПОСЛЕ static

// --- РОУТЫ OpenAI и Прочие ---
// Обработчик /api/thread остается БЕЗ ИЗМЕНЕНИЙ
app.post('/api/thread', async (req, res) => {
    logInfo(req, '/api/thread', 'Create thread requested');
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });
    try {
      const thread = await openai.beta.threads.create();
      logInfo(req, '/api/thread', 'Thread created successfully', { threadId: thread.id });
      res.json({ threadId: thread.id });
    } catch (error) {
      logError(req, '/api/thread', 'Error creating thread', error);
      res.status(500).json({ error: 'Failed to create thread' });
    }
});

// Обработчик /api/message остается БЕЗ ИЗМЕНЕНИЙ
app.post('/api/message', async (req, res) => {
    const context = '/api/message';
    logInfo(req, context, 'Message received', req.body);

    if (!openai) {
        logError(req, context, 'OpenAI client not initialized');
        return res.status(500).json({ error: 'OpenAI integration is not configured' });
    }

    try {
        const { threadId, message } = req.body;
        if (!threadId || !message) {
            logWarn(req, context, 'Missing threadId or message in request body');
            return res.status(400).json({ error: 'Thread ID and message are required' });
        }

        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });
        logInfo(req, context, 'User message added', { threadId });

        // === ИЗМЕНЕНИЕ 1: Добавлены instructions и tool_resources ===
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            instructions: `
WARRANTY RULE (MUST FOLLOW - TOP PRIORITY):
- Labor / Workmanship warranty: 1 YEAR from the service date.
- Parts / Materials warranty: 60 DAYS ONLY for parts/materials WE SUPPLY and install.
- NEVER say "60 days" when asked about labor or workmanship warranty - it is ALWAYS 1 YEAR.
- If asked about "warranty" in general, ALWAYS list BOTH warranties as two separate items.
- The 60-day warranty applies ONLY to physical parts/materials, NEVER to labor.
`,
            tools: [
                { type: "file_search" },
                {
                    type: "function",
                    function: {
                        name: "saveBookingToSheet",
                        description: "Save booking details (name, phone, service, etc.) to the system.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string", description: "Customer's full name" },
                                phone: { type: "string", description: "Customer's phone number" },
                                email: { type: "string", description: "Customer's email address (optional)" },
                                address: { type: "string", description: "Service address (optional)" },
                                service: { type: "string", description: "Service requested (e.g. TV Mounting)"},
                                time_slot: { type: "string", description: "Preferred service time/date (optional)"},
                                language: { type: "string", description: "Customer's preferred language (optional)"}
                            },
                            required: ["name", "phone", "service"]
                        }
                    }
                }
            ],
            tool_resources: {
                file_search: {
                    vector_store_ids: [process.env.OPENAI_VECTOR_STORE_ID]
                }
            }
        });
        // === КОНЕЦ ИЗМЕНЕНИЯ 1 ===
        logInfo(req, context, 'Assistant run created', { threadId, runId: run.id });

        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        const startTime = Date.now();
        const timeoutMs = 60000;

        while (['queued', 'in_progress', 'requires_action', 'cancelling'].includes(runStatus.status)) {
            logInfo(req, context, `Run status: ${runStatus.status}`, { runId: run.id });

            if (Date.now() - startTime > timeoutMs) {
                logError(req, context, `Run timed out after ${timeoutMs}ms`, { threadId, runId: run.id });
                try { await openai.beta.threads.runs.cancel(threadId, run.id); } catch(cancelErr) {/* ignore */}
                return res.status(504).json({ error: 'Request timed out waiting for OpenAI response' });
            }

            if (runStatus.status === 'requires_action') {
                logInfo(req, context, 'Function call detected', { runId: run.id });
                const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;

                let toolOutputs = [];
                await Promise.all(toolCalls.map(async (toolCall) => {
                    logInfo(req, context, `Processing function: ${toolCall.function.name}`, { toolCallId: toolCall.id });

                    if (toolCall.function.name === 'saveBookingToSheet') {
                        let outputJson = { status: 'Error', message: 'Default error before processing' };
                        try {
                            const args = JSON.parse(toolCall.function.arguments);
                            logInfo(req, context, `Function arguments parsed`, { toolCallId: toolCall.id });

                            const leadDataForSheet = {
                                reqId: req.id,
                                timestamp: new Date().toISOString(),
                                source: 'Chatbot',
                                name: args.name || '',
                                phone: normalizePhone(args.phone || ''),
                                email: args.email || null,
                                address: args.address || '',
                                service: args.service || '',
                                notes: `Time: ${args.time_slot || 'N/A'}; Lang: ${args.language || 'N/A'}; Raw Phone: ${args.phone || 'N/A'}`
                            };

                            logInfo(req, context, `Calling appendLeadToSheet`, { toolCallId: toolCall.id });
                            // ВАЖНО: Убедитесь, что appendLeadToSheet здесь тоже использует googleapis версию
                            const sheetResult = await appendLeadToSheet(req, leadDataForSheet);
                            logInfo(req, context, `Sheet result: ${sheetResult.success ? 'success' : 'failed'}`, { toolCallId: toolCall.id });

                            outputJson = sheetResult.success
                                ? { status: 'OK', message: 'Lead data successfully saved to Google Sheet.' }
                                : { status: 'Error', message: sheetResult.error || 'Failed to save to Google Sheet.' };

                        } catch (funcError) {
                            logError(req, context, `Error processing function call`, { toolCallId: toolCall.id, error: funcError });
                            outputJson = { status: 'Error', message: `Internal server error: ${funcError.message}` };
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(outputJson)
                        });
                    } else {
                        logWarn(req, context, `Unhandled function call requested`, { function: toolCall.function.name });
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: `Function ${toolCall.function.name} is not implemented.` })
                        });
                    }
                }));

                if (toolOutputs.length > 0) {
                    logInfo(req, context, 'Submitting tool outputs to OpenAI', { runId: run.id });
                    try {
                        runStatus = await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
                        logInfo(req, context, 'Tool outputs submitted successfully', { runId: run.id, newStatus: runStatus.status });
                    } catch (submitError) {
                        logError(req, context, 'Failed to submit tool outputs to OpenAI', { error: submitError });
                        return res.status(500).json({ error: 'Failed to communicate function results back to OpenAI.' });
                    }
                } else {
                    logWarn(req, context, 'Action required, but no tool outputs were generated', { runId: run.id });
                }
            }

            if (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
                 await new Promise(resolve => setTimeout(resolve, 1500));
                 runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
            } else {
                 break;
            }
        }

        logInfo(req, context, `Run finished with status: ${runStatus.status}`, { runId: run.id });

        if (runStatus.status === 'completed') {
           const messages = await openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
           logInfo(req, context, 'Retrieving final messages', { runId: run.id });
           const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
           if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
               const originalMessageContent = assistantMessage.content[0].text.value;
               // === ИЗМЕНЕНИЕ 2: Добавлен второй regex для очистки цитат ===
               const cleanedMessage = originalMessageContent
                   .replace(/【.*?†source】/g, '')
                   .replace(/\[\d+:\d+†[^\]]+\]/g, '')
                   .trim();
               // === КОНЕЦ ИЗМЕНЕНИЯ 2 ===
               logInfo(req, context, 'Original message length:', { len: originalMessageContent.length });
               logInfo(req, context, 'Cleaned message length:', { len: cleanedMessage.length });
               logInfo(req, context, 'Sending final cleaned assistant message to client', { runId: run.id });
               res.json({ message: cleanedMessage });
           } else {
               logWarn(req, context, 'No suitable text message found from assistant', { runId: run.id });
               res.status(500).json({ error: 'Assistant did not provide a final text response.' });
           }
        } else {
           logError(req, context, `Run ended with error status: ${runStatus.status}`, { runId: run.id });
           res.status(500).json({ error: `Request failed with status: ${runStatus.status}` });
        }

    } catch (error) {
        logError(req, context, 'Top-level error in message handler', { error });
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process message due to an internal error.' });
        }
    }
});

// Обработчики /api/health и /api/config остаются БЕЗ ИЗМЕНЕНИЙ
app.get('/api/health', (req, res) => {
    logInfo(req, '/api/health', 'Health check requested');
    if (!config.openai.apiKey || !config.openai.assistantId || !config.google.sheetId || !config.google.serviceAccountCredsJson) {
      logError(req, '/api/health', 'Server configuration incomplete');
      return res.status(500).json({ status: 'error', message: 'Server configuration incomplete' });
    }
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
    logInfo(req, '/api/config', 'Config requested');
    res.json({ assistantId: config.openai.assistantId });
});

// === ИЗМЕНЕННЫЙ ОБРАБОТЧИК ДЛЯ TILDA WEBHOOK (с QStash) ===
app.post('/api/webhook/tilda', async (req, res) => { // Обработчик теперь async
    const context = '/api/webhook/tilda';
    // req.id должен быть установлен мидлваром выше
    logInfo(req, context, 'Webhook received', req.body);

    // 1. Инициализация клиента QStash
    let qstashClient;
    if (process.env.QSTASH_TOKEN) {
        qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
        logInfo(req, context, 'QStash client initialized.');
    } else {
        logError(req, context, 'QSTASH_TOKEN environment variable is not set! Cannot queue message.');
        // Отвечаем Tilda, что получили, но обработать не сможем
        // Используем статус 200, чтобы Tilda не повторяла запрос
        return res.status(200).send('Webhook received (QStash config error)');
    }

    try {
        // 2. Извлечение и минимальная валидация данных
        const tildaData = req.body;
        const timestamp = new Date().toISOString();

        // Используем стандартные имена или имена из формы Tilda
        const name = tildaData.Name || tildaData.name || '';
        const rawPhone = tildaData.Phone || tildaData.phone || tildaData['Телефон'] || '';
        const phone = normalizePhone(rawPhone); // Нормализуем телефон
        const email = tildaData.Email || tildaData.email || ''; // Используем пустую строку по умолчанию, если не null
        const address = tildaData.Address || tildaData.address || '';
        const service = tildaData.service || tildaData.Service || '';

        // Собираем остальные поля в notes
        const knownFields = ['Name', 'name', 'Phone', 'phone', 'Телефон', 'Email', 'email', 'Address', 'address', 'service', 'Service', 'formid', 'formname', 'tranid', 'formtitle', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
        let notesContent = [];
        for (const key in tildaData) {
            if (tildaData.hasOwnProperty(key) && !knownFields.includes(key) && tildaData[key]) {
                notesContent.push(`${key}: ${tildaData[key]}`);
            }
        }

        // Валидация телефона (можно добавить и другие)
        if (!phone) {
            logWarn(req, context, 'Webhook skipped: Missing or invalid phone number.', tildaData);
            return res.status(200).send('Webhook received (invalid phone)'); // Отвечаем 200, но не ставим в очередь
        }

        // Формируем объект данных для отправки в очередь
        // Включаем все поля, которые могут понадобиться appendLeadToSheet
        const leadDataForQueue = {
            // reqId: req.id, // Можно передать ID исходного запроса для сквозного логирования
            timestamp: timestamp,
            source: 'Tilda Form',
            name: name,
            phone: phone,
            email: email,
            address: address,
            service: service,
            notes: notesContent.join('; ')
        };

        // 3. Публикация задачи в QStash
        logInfo(req, context, 'Publishing lead data to QStash queue...', { dataSize: JSON.stringify(leadDataForQueue).length });

        // Определяем URL обработчика очереди.
        // Используем process.env.VERCEL_URL для надежности на Vercel
        // или req.headers['x-forwarded-host'] как запасной вариант
        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
        const destinationUrl = `${baseUrl}/api/process-sheet-queue`;

        logInfo(req, context, `Destination URL for QStash: ${destinationUrl}`);

        const publishResponse = await qstashClient.publishJSON({
          // url: destinationUrl,
          topic: "google-sheet-endpoint", // <--- НОВОЕ ЗНАЧЕНИЕ (ИМЯ URL GROUP)
          body: leadDataForQueue,
          // ...
      });
      // Обновим и лог для ясности
      logInfo(req, context, 'Successfully published to QStash topic/destination "google-sheet-endpoint"', { messageId: publishResponse.messageId });

        // 4. Отвечаем Tilda СРАЗУ
        // (Ответ уже должен быть отправлен к этому моменту, если не было ошибок выше)
        if (!res.headersSent) {
             res.status(200).send('Webhook received, queued for processing');
        }

    } catch (error) {
        logError(req, context, 'Error processing webhook or publishing to QStash', error);
        // Отвечаем только если еще не ответили
        if (!res.headersSent) {
            res.status(200).send('Webhook received (processing error)');
        }
    }
});
// ===================================================

// --- КОНЕЦ: Блок Роутов ---

// --- Экспорт приложения для Vercel И Запуск для Node.js ---
// Обработчик /api/process-sheet-queue НЕ ДОЛЖЕН быть здесь, он в отдельном файле!
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server running directly via Node.js on http://localhost:${PORT}`);
  });
}
// ------------------------------------