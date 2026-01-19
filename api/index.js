// api/index.js (Updated for Hybrid Form Submission & Safety)

// --- НАЧАЛО: Блок Импортов ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
// Подключаем ПОЛНУЮ рабочую версию googleSheetService
const { appendLeadToSheet } = require('../lib/googleSheetService');
const { logInfo, logError, logger, logWarn } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { validateLeadData } = require('../lib/utils/validate');
const { Client } = require("@upstash/qstash");
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
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    if (!req.originalUrl.includes('/api/process-sheet-queue')) {
       logInfo(req, `${req.method} ${req.originalUrl}`, { headers: req.headers });
    }
    next();
});
app.use(cors(config.cors.options));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '..', 'public')));
// --- КОНЕЦ: Блок Middleware ---


// --- НАЧАЛО: Блок Роутов ---

// --- 1. Создание Треда ---
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

// --- 2. Обработка Сообщений (ГЛАВНАЯ ЛОГИКА) ---
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
            return res.status(400).json({ error: 'Thread ID and message are required' });
        }

        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });
        logInfo(req, context, 'User message added', { threadId });

        // Передаем только динамические данные (время).
        // Правила гарантии (1 год / 60 дней) должны быть в System Instructions в OpenAI Dashboard.
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            instructions: `Current date and time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}.`,
            // Tools определены в Assistant ID, но можно продублировать при необходимости,
            // здесь полагаемся на настройки ассистента или дефолтные тулзы.
        });
        
        logInfo(req, context, 'Assistant run created', { threadId, runId: run.id });

        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        const startTime = Date.now();
        const timeoutMs = 50000; // Уменьшено до 50с для безопасности Vercel (лимит 60с)

        // Переменная для хранения действия формы, которое мы отправим на фронтенд
        let formActionData = null;

        while (['queued', 'in_progress', 'requires_action', 'cancelling'].includes(runStatus.status)) {
            
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
                            
                            // === МАГИЯ: Запоминаем данные для авто-заполнения формы на сайте ===
                            formActionData = {
                                type: 'FILL_FORM',
                                payload: {
                                    name: args.name || '',
                                    phone: args.phone || '',
                                    email: args.email || '',
                                    service: args.service || ''
                                }
                            };
                            // ===================================================================

                            const leadDataForSheet = {
                                reqId: req.id,
                                timestamp: new Date().toISOString(),
                                source: 'Chatbot',
                                name: args.name || '',
                                phone: normalizePhone(args.phone || ''),
                                email: args.email || null,
                                address: args.address || '',
                                service: args.service || '',
                                notes: `Time: ${args.time_slot || 'N/A'}; Lang: ${args.language || 'N/A'}`
                            };

                            const sheetResult = await appendLeadToSheet(req, leadDataForSheet);
                            
                            outputJson = sheetResult.success
                                ? { status: 'OK', message: 'Lead data saved. Confirm to user.' }
                                : { status: 'Error', message: sheetResult.error || 'Failed to save.' };

                        } catch (funcError) {
                            logError(req, context, `Error processing function call`, { toolCallId: toolCall.id, error: funcError });
                            outputJson = { status: 'Error', message: `Internal server error: ${funcError.message}` };
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(outputJson)
                        });
                    } else {
                        // Обработка других функций (если есть)
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: 'Function not implemented' })
                        });
                    }
                }));

                if (toolOutputs.length > 0) {
                    try {
                        runStatus = await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
                    } catch (submitError) {
                        logError(req, context, 'Failed to submit tool outputs', { error: submitError });
                        return res.status(500).json({ error: 'Failed to communicate with AI.' });
                    }
                }
            }

            if (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
                 await new Promise(resolve => setTimeout(resolve, 1000)); // Поллинг раз в 1с
                 runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
            } else {
                 break;
            }
        }

        if (runStatus.status === 'completed') {
           const messages = await openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
           const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
           
           if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
               const originalMessageContent = assistantMessage.content[0].text.value;
               const cleanedMessage = originalMessageContent
                   .replace(/【.*?†source】/g, '')
                   .replace(/\[\d+:\d+†[^\]]+\]/g, '')
                   .trim();

               // Отправляем ответ клиенту. Включаем action, если он есть.
               res.json({ 
                   message: cleanedMessage,
                   action: formActionData // <--- Передаем команду фронтенду
               });
           } else {
               res.status(500).json({ error: 'No text response from assistant.' });
           }
        } else {
           res.status(500).json({ error: `Request failed with status: ${runStatus.status}` });
        }

    } catch (error) {
        logError(req, context, 'Top-level error', { error });
        if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- 3. Health & Config ---
app.get('/api/health', (req, res) => {
    if (!config.openai.apiKey || !config.google.sheetId) {
      return res.status(500).json({ status: 'error', message: 'Config incomplete' });
    }
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
    res.json({ assistantId: config.openai.assistantId });
});

// --- 4. Webhook Tilda (с QStash) ---
app.post('/api/webhook/tilda', async (req, res) => {
    const context = '/api/webhook/tilda';
    logInfo(req, context, 'Webhook received', req.body);

    let qstashClient;
    if (process.env.QSTASH_TOKEN) {
        qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
    } else {
        logError(req, context, 'QSTASH_TOKEN missing');
        return res.status(200).send('Received (Config Error)');
    }

    try {
        const tildaData = req.body;
        const phone = normalizePhone(tildaData.Phone || tildaData.phone || tildaData['Телефон'] || '');

        if (!phone) {
            return res.status(200).send('Received (Invalid Phone)');
        }

        const leadDataForQueue = {
            timestamp: new Date().toISOString(),
            source: 'Tilda Form',
            name: tildaData.Name || tildaData.name || '',
            phone: phone,
            email: tildaData.Email || tildaData.email || '',
            address: tildaData.Address || tildaData.address || '',
            service: tildaData.service || tildaData.Service || '',
            notes: JSON.stringify(tildaData)
        };

        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `${req.protocol}://${req.get('host')}`;
        // Можно использовать конкретный топик или прямой URL
        await qstashClient.publishJSON({
            url: `${baseUrl}/api/process-sheet-queue`,
            body: leadDataForQueue,
        });

        if (!res.headersSent) res.status(200).send('Queued');

    } catch (error) {
        logError(req, context, 'Error processing webhook', error);
        if (!res.headersSent) res.status(200).send('Received (Error)');
    }
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
}