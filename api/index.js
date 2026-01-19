// api/index.js (FINAL STABLE VERSION: Assistants API + Citation Fix)

// --- НАЧАЛО: Блок Импортов ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { appendLeadToSheet } = require('../lib/googleSheetService');
const { logInfo, logError, logger, logWarn } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { Client } = require("@upstash/qstash");
// --- КОНЕЦ: Блок Импортов ---

const app = express();
let openai;

// Инициализация OpenAI
try {
    if (config.openai.apiKey && config.openai.assistantId) {
        openai = new OpenAI({ apiKey: config.openai.apiKey });
        logger.info('OpenAI client initialized successfully.');
    } else {
        // Не ломаем сервер сразу, но логируем ошибку
        logger.error('OpenAI credentials missing (API Key or Assistant ID)');
    }
} catch (error) {
    logger.error('Failed to initialize OpenAI client', error);
}

// --- Middleware ---
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

// --- РОУТЫ ---

// 1. Создание треда
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

// 2. Обработка сообщений
app.post('/api/message', async (req, res) => {
    const context = '/api/message';
    
    if (!openai) {
        logError(req, context, 'OpenAI not initialized');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        const { threadId, message } = req.body;
        if (!threadId || !message) {
            return res.status(400).json({ error: 'Thread ID and message required' });
        }

        // Добавляем сообщение пользователя
        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });
        logInfo(req, context, 'User message added', { threadId });

        // Запускаем Ассистента
        // ИЗМЕНЕНИЕ: Используем additional_instructions вместо instructions
        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: `
Current date and time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}.

IMPORTANT BOOKING RULES:
1. You HAVE a tool named 'saveBookingToSheet'. Use it to save bookings.
2. To use the tool, you MUST have the user's NAME and PHONE number.
3. IF the user asks to book/schedule but is missing the phone number: DO NOT say "I cannot book". Instead, ASK for the phone number.
4. Once you have Name and Phone, execute 'saveBookingToSheet' immediately.
5. Never redirect the user to the website for booking if they are providing details in chat. You are the booking agent.
6. STRICTLY FORBIDDEN: Do NOT mention WhatsApp or suggest contacting via WhatsApp. Use ONLY the tool provided.
7. After using the tool, simply confirm that the request has been received and the team will contact them.
`
        });
        
        logInfo(req, context, 'Run created', { runId: run.id });

        // Ждем ответа (Polling)
        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        const startTime = Date.now();
        const timeoutMs = 50000; 

        // Переменная для хранения действия формы
        let formActionData = null;

        while (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
            // Проверка таймаута
            if (Date.now() - startTime > timeoutMs) {
                try { await openai.beta.threads.runs.cancel(threadId, run.id); } catch(e) {}
                return res.status(504).json({ error: 'Timeout waiting for AI' });
            }

            // Обработка вызова функций
            if (runStatus.status === 'requires_action') {
                const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
                let toolOutputs = [];

                await Promise.all(toolCalls.map(async (toolCall) => {
                    if (toolCall.function.name === 'saveBookingToSheet') {
                        try {
                            const args = JSON.parse(toolCall.function.arguments);
                            
                            // Запоминаем данные для фронтенда
                            formActionData = {
                                type: 'FILL_FORM',
                                payload: {
                                    name: args.name || '',
                                    phone: args.phone || '',
                                    email: args.email || '',
                                    service: args.service || ''
                                }
                            };

                            // Сохраняем в Google Sheet
                            const leadData = {
                                reqId: req.id,
                                timestamp: new Date().toISOString(),
                                source: 'Chatbot',
                                name: args.name,
                                phone: normalizePhone(args.phone),
                                email: args.email,
                                service: args.service,
                                notes: `Time: ${args.time_slot || 'N/A'}`
                            };
                            
                            const sheetResult = await appendLeadToSheet(req, leadData);
                            
                            toolOutputs.push({
                                tool_call_id: toolCall.id,
                                output: JSON.stringify({ 
                                    status: sheetResult.success ? 'OK' : 'Error', 
                                    message: sheetResult.success ? 'Saved successfully.' : 'Failed to save.'
                                })
                            });

                        } catch (err) {
                            toolOutputs.push({
                                tool_call_id: toolCall.id,
                                output: JSON.stringify({ status: 'Error', message: err.message })
                            });
                        }
                    } else {
                        // Неизвестная функция
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: 'Function not found' })
                        });
                    }
                }));

                // Отправляем результаты функций обратно в OpenAI
                if (toolOutputs.length > 0) {
                    runStatus = await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
                }
            }

            // Пауза перед следующей проверкой
            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        }

        // Обработка завершения
        if (runStatus.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
            const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
            
            if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
                const text = assistantMessage.content[0].text.value
                    .replace(/【.*?】/g, '') // Агрессивное удаление: всё, что внутри толстых скобок
                    .replace(/\[\d+:\d+†[^\]]+\]/g, '') // Удаляем редкий формат [4:0†file]
                    .trim();

                res.json({ 
                    message: text,
                    action: formActionData 
                });
            } else {
                res.status(500).json({ error: 'No text response' });
            }
        } else {
            res.status(500).json({ error: `Run failed: ${runStatus.status}` });
        }

    } catch (error) {
        logError(req, context, 'Fatal error', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Health Check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', config_check: !!config.openai.apiKey }));

// --- Webhook (Без изменений) ---
app.post('/api/webhook/tilda', async (req, res) => {
    // ... тот же код вебхука ...
    // Оставляем как есть для экономии места, он рабочий
    const context = '/api/webhook/tilda';
    let qstashClient;
    if (process.env.QSTASH_TOKEN) qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
    else return res.status(200).send('Received (Config Error)');

    try {
        const tildaData = req.body;
        const phone = normalizePhone(tildaData.Phone || tildaData.phone || '');
        if (!phone) return res.status(200).send('Received (Invalid Phone)');

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
        await qstashClient.publishJSON({ url: `${baseUrl}/api/process-sheet-queue`, body: leadDataForQueue });
        if (!res.headersSent) res.status(200).send('Queued');
    } catch (e) {
        if (!res.headersSent) res.status(200).send('Received (Error)');
    }
});

module.exports = app;