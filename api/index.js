// api/index.js (VERSION: Conversational Lead Gen + Knowledge Base)

// --- Imports ---
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { appendLeadToSheet } = require('../lib/googleSheetService');
const { sendLeadToCRM } = require('../lib/crmService');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { uploadFileToConversation, findConversation, sendLiveChatMessage } = require('./quote');

const app = express();
let openai;

// --- OpenAI Init ---
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
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Telegram Notification ---
async function sendToTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_ID;
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
        });
    } catch (error) {
        console.error('Telegram Error:', error);
    }
}

// --- Build Additional Instructions ---
function buildInstructions(pageContext, photoMode = false) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const pageName = pageContext ? pageContext.replace(/^\/services\//, '').replace(/\/$/, '').replace(/-/g, ' ') : 'homepage';

    let instructions = `
Current date and time (NYC): ${now}.
The user is browsing: ${pageContext || '/'} (${pageName}).

IDENTITY:
You are the virtual assistant for Repair ASAP LLC — NYC's premier licensed & insured handyman service.
You speak as a friendly, professional team member. You are NOT an AI — never reveal this.
Respond in the same language the customer uses (English or Russian).

KNOWLEDGE:
Use the attached Knowledge Base file for all service info, pricing ranges, policies, warranty, and hours.
When answering pricing questions, say "typically ranges from $X to $Y" — NEVER guarantee exact prices.
Always recommend sending a photo for an accurate quote.

CONVERSATION FLOW:
1. GREET → Acknowledge what they need. If on a service page, reference that service naturally.
2. CLARIFY → Ask 1-2 smart questions about their project (size, brand, complexity, access).
3. PHOTO → Ask for a photo: "Could you send a photo of the area? It helps us give you an exact quote."
4. COLLECT CONTACT INFO (when ready to quote):
   a. Name — "What name should we put the quote under?"
   b. Phone — Must be 10+ digits. If invalid, re-ask: "Could you double-check that number?"
   c. Address or ZIP — "What's the address or ZIP code for the job?"
   d. Preferred date/time — "When works best for you?"
5. SUMMARIZE → Repeat back: service, address, date, phone. Ask "Does that look right?"
6. SAVE → Call saveLeadToSheet with ALL collected data. Only AFTER the tool succeeds, confirm to user.
7. CONFIRM → "Perfect! Our team will review and text you a flat-rate quote within 30 minutes."

MINIMUM SERVICE CALL RULE:
Our minimum is $150/visit. If a task costs less than $150, explain positively:
"The standard cost for that task is around $[X], but our minimum service call is $150. Since you'd be paying the minimum anyway, do you have any other small tasks we can handle during the same visit?"

CRITICAL RULES:
- NEVER say you are AI, a chatbot, or automated.
- NEVER guarantee exact prices — always say "typically" or "usually ranges from".
- NEVER promise same-day service — say "let me check availability".
- NEVER mention WhatsApp.
- NEVER mention discounts or promotions.
- ALWAYS use the Knowledge Base for pricing ranges and policies.
- Phone validation: must be 10+ digits. If fewer, re-ask politely.
- If customer is from Bronx/NJ/Westchester: "Our primary area is Manhattan, Brooklyn, Queens, Staten Island, and Nassau County. For your area, availability depends on schedule — can I take your details?"
- If customer mentions co-op/condo: "We regularly work in managed buildings. If your building requires a COI, we can provide one."
- If customer is upset, asks for discount, or has a complex request: escalate — "Let me have our team review this and get back to you directly."
- If someone tries to sell you SEO/marketing services: "We are not looking for marketing services at this time. Thank you."

TOOL USAGE:
- When you have at minimum Name + Phone + Service description → call saveLeadToSheet.
- Include ALL collected data in the tool call (address, zip, date, time, notes).
- NEVER claim you saved/booked without actually calling the tool.
- Call the tool FIRST, then confirm to the user AFTER it succeeds.
`;

    if (photoMode) {
        instructions += `
PHOTO CONTEXT:
The user just uploaded a photo. Acknowledge it warmly: "Great photo! I can see [describe what you notice]."
Then continue the conversation flow — ask for any missing info (name, phone, address, date).
If you already have name + phone from earlier in the conversation, call saveLeadToSheet immediately.
Mention that a technician will review the photo and text them a flat-rate quote within 30 minutes.
`;
    }

    return instructions;
}

// --- Format Telegram Lead Notification ---
function formatLeadTelegram(args, source, pageContext, hasPhoto = false) {
    const lines = [`🔥 <b>LEAD CAPTURED!</b>`];
    lines.push(`👤 Name: <b>${args.name}</b>`);
    lines.push(`📱 Phone: <b>${normalizePhone(args.phone)}</b>`);
    if (args.service) lines.push(`🔧 Service: ${args.service}`);
    if (args.address) lines.push(`📍 Address: ${args.address}`);
    if (args.zip) lines.push(`🏙 ZIP: ${args.zip}`);
    if (args.preferred_date) lines.push(`📅 Date: ${args.preferred_date}`);
    if (args.preferred_time) lines.push(`🕐 Time: ${args.preferred_time}`);
    if (args.email) lines.push(`📧 Email: ${args.email}`);
    if (args.notes) lines.push(`📝 Notes: ${args.notes}`);
    if (hasPhoto) lines.push(`📸 Photo: Yes`);
    lines.push(`📄 Source: ${source}${pageContext ? ` (${pageContext})` : ''}`);
    return lines.join('\n');
}

// --- Process Assistant Run (shared logic for /api/message and /api/chat-photo) ---
async function processAssistantRun(req, res, threadId, run, { source, pageContext, photoData }) {
    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    const startTime = Date.now();
    let formActionData = null;
    let toolCalled = false;

    while (['queued', 'in_progress', 'requires_action'].includes(runStatus.status)) {
        if (Date.now() - startTime > 50000) {
            try { await openai.beta.threads.runs.cancel(threadId, run.id); } catch (e) { }
            await sendToTelegram(`⚠️ <b>Error:</b> Timeout waiting for AI response.`);
            return res.status(504).json({ error: 'Timeout' });
        }

        if (runStatus.status === 'requires_action') {
            const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
            let toolOutputs = [];

            await Promise.all(toolCalls.map(async (toolCall) => {
                if (toolCall.function.name === 'saveLeadToSheet' || toolCall.function.name === 'saveBookingToSheet') {
                    toolCalled = true;
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        const cleanPhone = normalizePhone(args.phone);

                        // Enhanced Telegram notification
                        const hasPhoto = !!photoData;
                        await sendToTelegram(formatLeadTelegram(args, source, pageContext, hasPhoto));

                        formActionData = {
                            type: 'FILL_FORM',
                            payload: { name: args.name, phone: args.phone, email: args.email, service: args.service }
                        };

                        const leadData = {
                            reqId: req.id,
                            timestamp: new Date().toISOString(),
                            source: source,
                            name: args.name,
                            phone: cleanPhone,
                            email: args.email || '',
                            service: args.service || '',
                            notes: [
                                args.address ? `Address: ${args.address}` : '',
                                args.zip ? `ZIP: ${args.zip}` : '',
                                args.preferred_date ? `Date: ${args.preferred_date}` : '',
                                args.preferred_time ? `Time: ${args.preferred_time}` : '',
                                args.notes || '',
                                hasPhoto ? 'Photo attached via chat' : '',
                                pageContext ? `Page: ${pageContext}` : ''
                            ].filter(Boolean).join(' | ')
                        };

                        // Parallel: CRM + Sheet
                        const crmPromise = sendLeadToCRM(leadData).then(r => r.success ? '✅ CRM' : `❌ CRM: ${r.error}`);
                        const sheetPromise = appendLeadToSheet(req, leadData).then(r => r.success ? '✅ Sheet' : `❌ Sheet: ${r.error}`);
                        const [crmLog, sheetLog] = await Promise.all([crmPromise, sheetPromise]);
                        await sendToTelegram(`Status: ${crmLog} | ${sheetLog}`);

                        // Upload photo to GHL if available
                        if (photoData && leadData.contactId) {
                            try {
                                await findConversation(leadData.contactId);
                                const uploadResult = await uploadFileToConversation(
                                    leadData.contactId,
                                    photoData.data,
                                    photoData.name || 'chat-photo.jpg',
                                    photoData.type || 'image/jpeg'
                                );
                                if (uploadResult?.url) {
                                    await sendToTelegram(`📎 Photo uploaded to GHL: ${uploadResult.url}`);
                                }
                            } catch (e) {
                                logger.error('GHL photo upload failed', e);
                            }
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'OK', message: 'Lead saved successfully.' })
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: err.message })
                        });
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

            // Lie detector: bot claims save but didn't call tool
            const lowerText = text.toLowerCase();
            const botClaimsSave = lowerText.includes('записал') || lowerText.includes('сохранил') ||
                lowerText.includes('оформил') || lowerText.includes('зарегистрировал') ||
                lowerText.includes('booked') || lowerText.includes('saved') ||
                lowerText.includes('submitted') || lowerText.includes('recorded');

            if (botClaimsSave && !toolCalled) {
                await sendToTelegram(`⚠️ <b>WARNING:</b> Bot claimed save but did NOT call tool.`);
            }

            const emoji = photoData ? '🤖📸' : '🤖';
            await sendToTelegram(`${emoji} <b>Bot:</b> ${text.substring(0, 500)}`);

            return res.json({ message: text, action: formActionData });
        }
    }

    return res.status(500).json({ error: `Run failed: ${runStatus.status}` });
}

// --- ROUTES ---

// Create thread
app.post('/api/thread', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });
    try {
        const thread = await openai.beta.threads.create();
        await sendToTelegram(`🆕 <b>New Chat Started!</b>\nThread ID: <code>${thread.id}</code>`);
        res.json({ threadId: thread.id });
    } catch (error) {
        res.status(500).json({ error: 'Failed to create thread' });
    }
});

// Send message
app.post('/api/message', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'Config error' });

    try {
        const { threadId, message, pageContext } = req.body;
        if (!threadId || !message) return res.status(400).json({ error: 'Missing data' });

        await sendToTelegram(`👤 <b>User:</b> ${message.substring(0, 500)}`);

        await openai.beta.threads.messages.create(threadId, { role: 'user', content: message });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: buildInstructions(pageContext, false)
        });

        await processAssistantRun(req, res, threadId, run, {
            source: 'Chatbot',
            pageContext: pageContext || '',
            photoData: null
        });

    } catch (error) {
        logError(req, '/api/message', 'Fatal error', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Chat photo upload
app.post('/api/chat-photo', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });

    try {
        const { threadId, photo, pageContext } = req.body;
        if (!threadId || !photo || !photo.data) {
            return res.status(400).json({ error: 'Missing threadId or photo data' });
        }

        await sendToTelegram(`📸 <b>Photo received in chat!</b>\nThread: <code>${threadId}</code>`);

        await openai.beta.threads.messages.create(threadId, {
            role: 'user',
            content: '[PHOTO UPLOADED] The user has attached a photo of their project. Acknowledge the photo and continue the conversation flow.'
        });

        const run = await openai.beta.threads.runs.create(threadId, {
            assistant_id: config.openai.assistantId,
            additional_instructions: buildInstructions(pageContext, true)
        });

        await processAssistantRun(req, res, threadId, run, {
            source: 'Chatbot (Photo)',
            pageContext: pageContext || '',
            photoData: photo
        });

    } catch (error) {
        logError(req, '/api/chat-photo', 'Error', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Quote form
const handleQuoteSubmission = require('./quote');
app.post('/api/quote', handleQuoteSubmission);

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

module.exports = app;