// api/index.js (FINAL VERSION: Responses API Architecture)

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
    if (config.openai.apiKey) {
        openai = new OpenAI({ apiKey: config.openai.apiKey });
        logger.info('OpenAI client initialized.');
    } else {
        throw new Error('OpenAI API Key is missing.');
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

// 1. Создание треда (Оставляем для совместимости с фронтендом, но он будет фиктивным)
app.post('/api/thread', (req, res) => {
    // В новой архитектуре Responses API нам не нужен thread_id на сервере,
    // но фронтенд его ждет, поэтому возвращаем заглушку.
    res.json({ threadId: 'thread_stateless_' + uuidv4() });
});

// 2. Обработка сообщений (Responses API)
app.post('/api/message', async (req, res) => {
    const context = '/api/message';
    
    if (!openai) return res.status(500).json({ error: 'OpenAI not configured' });
    
    const { message } = req.body; // threadId нам больше не важен для логики OpenAI
    
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        logInfo(req, context, 'Sending request to OpenAI Responses API...');

        // === ГЛАВНОЕ ИЗМЕНЕНИЕ: Responses API ===
        const response = await openai.responses.create({
            model: "gpt-4o-mini", // Используем актуальную модель
            input: message,
            tools: [
                {
                    type: "file_search",
                    vector_store_ids: [process.env.OPENAI_VECTOR_STORE_ID], // ID хранилища из Vercel
                    max_num_results: 3
                },
                {
                    type: "function",
                    function: {
                        name: "saveBookingToSheet",
                        description: "Save booking details (name, phone, etc) and confirm to user.",
                        parameters: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                phone: { type: "string" },
                                email: { type: "string" },
                                service: { type: "string" }
                            },
                            required: ["name", "phone"]
                        }
                    }
                }
            ]
        });

        // Обработка ответа
        let responseText = response.output_text || "I processed your request.";
        let formActionData = null;

        // Проверяем, вызвал ли бот функцию (инструмент)
        if (response.tool_calls && response.tool_calls.length > 0) {
            for (const toolCall of response.tool_calls) {
                if (toolCall.function.name === 'saveBookingToSheet') {
                    logInfo(req, context, 'Function call detected: saveBookingToSheet');
                    
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        
                        // 1. Формируем команду для фронтенда (заполнить форму)
                        formActionData = {
                            type: 'FILL_FORM',
                            payload: {
                                name: args.name || '',
                                phone: args.phone || '',
                                email: args.email || '',
                                service: args.service || ''
                            }
                        };

                        // 2. Сохраняем в таблицу
                        const leadData = {
                            reqId: req.id,
                            timestamp: new Date().toISOString(),
                            source: 'Chatbot (Responses API)',
                            name: args.name,
                            phone: normalizePhone(args.phone),
                            email: args.email,
                            service: args.service,
                            notes: 'Auto-saved via Chat'
                        };
                        
                        await appendLeadToSheet(req, leadData);
                        
                        // Если бот не дал текстового ответа, добавляем подтверждение
                        if (!responseText || responseText === "I processed your request.") {
                            responseText = "I've saved your details! Please check the form below.";
                        }

                    } catch (err) {
                        logError(req, context, 'Error processing tool call', err);
                    }
                }
            }
        }
        
        // Очистка текста от ссылок на источники
        const cleanedMessage = responseText
            .replace(/【.*?†source】/g, '')
            .replace(/\[\d+:\d+†[^\]]+\]/g, '')
            .trim();

        // Отправляем ответ + Action (если был)
        res.json({ 
            message: cleanedMessage,
            action: formActionData 
        });

    } catch (error) {
        logError(req, context, 'Error in Responses API', error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});

// --- Health Check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Webhook Tilda (Без изменений) ---
app.post('/api/webhook/tilda', async (req, res) => {
    // ... тот же код вебхука, что и был ...
    // (для краткости не дублирую, так как он не меняется)
    const context = '/api/webhook/tilda';
    logInfo(req, context, 'Webhook received', req.body);
    let qstashClient;
    if (process.env.QSTASH_TOKEN) {
        qstashClient = new Client({ token: process.env.QSTASH_TOKEN });
    } else {
        return res.status(200).send('Received (Config Error)');
    }
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
        await qstashClient.publishJSON({
            url: `${baseUrl}/api/process-sheet-queue`,
            body: leadDataForQueue,
        });
        if (!res.headersSent) res.status(200).send('Queued');
    } catch (error) {
        if (!res.headersSent) res.status(200).send('Received (Error)');
    }
});

module.exports = app;