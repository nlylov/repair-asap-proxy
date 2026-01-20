// api/index.js (VERSION: Assistants API + Telegram Monitoring)

// --- НАЧАЛО: Блок Импортов ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { appendLeadToSheet } = require('../lib/googleSheetService');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
// --- КОНЕЦ: Блок Импортов ---

const app = express();
let openai;

// Инициализация OpenAI
try {
    if (config.openai.apiKey && config.openai.assistantId) {
        openai = new OpenAI({ apiKey: config.openai.apiKey });
        logger.info('OpenAI client initialized successfully.');
    } else {
        logger.error('OpenAI credentials missing');
    }
} catch (error) {
    logger.error('Failed to initialize OpenAI client', error);
}

// --- Middleware ---
app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || uuidv4();
    res.setHeader('X-Request-ID', req.id);
    logInfo(req, `${req.method} ${req.originalUrl}`, { headers: req.headers });
    next();
});
app.use(cors(config.cors.options));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- ФУНКЦИЯ: Отправка в Telegram ---
async function sendToTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_ID;

    if (!token || !chatId) return; // Если не настроено, молча пропускаем

    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML' // Позволяет делать жирный текст
            })
        });
    } catch (error) {
        console.error('Telegram Error:', error);
    }
}

// --- РОУТЫ ---

app.post('/api/thread', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });
    try {
      const thread = await openai.beta.threads.create();
      
      // Уведомление о новом диалоге
      sendToTelegram(`🆕 <b>New Chat Started!</b>\nThread ID: <code>${thread.id}</code>`);
      
      res.json({ threadId: thread.id });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create thread' });
    }
});

app.post('/api/message', async (req, res) => {
    const context = '/api/message';
    if (!openai) return res.status(500).json({ error: 'Config error' });

    try {
        const { threadId, message } = req.body;
        if (!threadId || !message) return res.status(400).json({ error: 'Missing data' });

        // 1. Шлем вопрос пользователя в Telegram
        sendToTelegram(`👤 <b>User:</b> ${message}`);

        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: `
Current date: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}.
IMPORTANT:
1. Use 'saveBookingToSheet' to save bookings (Name + Phone required).
2. If phone is missing, ASK for it.
3. NEVER mention WhatsApp.
4. If asked about price AND booking, give price FIRST.
`
        });

        let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        const startTime = Date.now();
        let formActionData = null;

        while (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
            if (Date.now() - startTime > 50000) {
                try { await openai.beta.threads.runs.cancel(threadId, run.id); } catch(e) {}
                sendToTelegram(`⚠️ <b>Error:</b> Timeout waiting for AI response.`);
                return res.status(504).json({ error: 'Timeout' });
            }

            if (runStatus.status === 'requires_action') {
                const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
                let toolOutputs = [];

                await Promise.all(toolCalls.map(async (toolCall) => {
                    if (toolCall.function.name === 'saveBookingToSheet') {
                        try {
                            const args = JSON.parse(toolCall.function.arguments);
                            
                            // Уведомление о ЛИДЕ в Telegram!
                            sendToTelegram(`🔥 <b>LEAD CAPTURED!</b>\nName: ${args.name}\nPhone: ${args.phone}\nService: ${args.service || 'N/A'}`);

                            formActionData = {
                                type: 'FILL_FORM',
                                payload: { name: args.name, phone: args.phone, email: args.email, service: args.service }
                            };

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
                            toolOutputs.push({ tool_call_id: toolCall.id, output: JSON.stringify({ status: 'Error', message: err.message }) });
                        }
                    }
                }));

                if (toolOutputs.length > 0) {
                    runStatus = await openai.beta.threads.runs.submitToolOutputs(threadId, run.id, { tool_outputs: toolOutputs });
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
        }

        if (runStatus.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(threadId, { limit: 1, order: 'desc' });
            const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
            
            if (assistantMessage && assistantMessage.content[0]?.type === 'text') {
                const text = assistantMessage.content[0].text.value
                    .replace(/【.*?】/g, '')
                    .replace(/\[\d+:\d+†[^\]]+\]/g, '')
                    .trim();

                // 2. Шлем ответ бота в Telegram
                sendToTelegram(`🤖 <b>Bot:</b> ${text}`);

                res.json({ message: text, action: formActionData });
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

module.exports = app;