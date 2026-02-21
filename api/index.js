// api/index.js (VERSION: Conversational Lead Gen + Knowledge Base v2)

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
const { getAvailableSlots, bookAppointment } = require('../lib/calendarService');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { normalizePhone } = require('../lib/utils/phone');
const { uploadFileToConversation, findConversation, sendLiveChatMessage, createOpportunity } = require('./quote');

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

// --- In-memory photo cache (threadId → photoData) with TTL ---
// Serverless lambdas stay warm for minutes, enough for a chat session
const photoCache = new Map();
const PHOTO_TTL_MS = 30 * 60 * 1000; // 30 minutes
function cachePhoto(threadId, photo) {
    photoCache.set(threadId, { photo, expires: Date.now() + PHOTO_TTL_MS });
    // Cleanup old entries
    for (const [key, val] of photoCache) {
        if (val.expires < Date.now()) photoCache.delete(key);
    }
}
function getCachedPhoto(threadId) {
    const entry = photoCache.get(threadId);
    if (entry && entry.expires > Date.now()) return entry.photo;
    photoCache.delete(threadId);
    return null;
}

// --- Telegram Text Notification ---
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

// --- Telegram Photo Forwarding ---
async function sendPhotoToTelegram(base64Data, caption = '') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_ADMIN_ID;
    if (!token || !chatId || !base64Data) return;
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        const boundary = '----FormBoundary' + Date.now();
        const parts = [];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="chat-photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
        const header = parts.join('\r\n');
        const footer = `\r\n--${boundary}--\r\n`;
        const bodyBuffer = Buffer.concat([Buffer.from(header), buffer, Buffer.from(footer)]);
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: bodyBuffer
        });
    } catch (error) {
        console.error('Telegram Photo Error:', error);
    }
}

// --- Build Additional Instructions ---
function buildInstructions(pageContext, photoMode = false) {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours();
    const isBusinessHours = hour >= 8 && hour < 20; // 8 AM – 8 PM
    const pageName = pageContext ? pageContext.replace(/^\/services\//, '').replace(/\/$/, '').replace(/-/g, ' ') : 'homepage';

    let instructions = `
Current date and time (NYC): ${now}.
Business hours status: ${isBusinessHours ? 'OPEN (8 AM – 8 PM)' : 'AFTER HOURS — respond accordingly'}.
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
6. SAVE → Call saveLeadToSheet with ALL collected data. You MUST call this function. Only AFTER the tool succeeds, confirm to user.
7. SCHEDULE → After saving the lead, if the user requested a specific date/time:
   a. Call checkAvailability with the requested date to see available slots.
   b. If the requested time is available → immediately call bookAppointment.
   c. If NOT available → show 2-3 alternative slots from the results: "That time is taken. Here are available slots: [list]. Which works for you?"
   d. When user picks a slot → call bookAppointment.
   e. If NO slots on that day → suggest the next day with availability.
8. CONFIRM BOOKING → After bookAppointment succeeds:
   "Your appointment is confirmed for [date] at [time]! Our technician will text you 30 minutes before arrival at [phone]. Thank you!"
   If booking isn't needed (user didn't request a date), use the standard lead confirmation:
   "Perfect! Your request has been submitted. Our team will review the details and text you a flat-rate quote within 30 minutes at [phone]. Thank you!"
   However, if it is AFTER HOURS (before 8 AM or after 8 PM NYC time), replace "within 30 minutes" with "first thing in the morning". Example: "...text you a flat-rate quote first thing in the morning at [phone]."

MINIMUM SERVICE CALL RULE:
Our minimum is $150/visit. If a task costs less than $150, explain positively:
"The standard cost for that task is around $[X], but our minimum service call is $150. Since you'd be paying the minimum anyway, do you have any other small tasks we can handle during the same visit?"

CRITICAL RULES:
- NEVER say you are AI, a chatbot, or automated.
- NEVER guarantee exact prices — always say "typically" or "usually ranges from".
- NEVER promise same-day service — say "let me check availability".
- NEVER mention WhatsApp. Do NOT generate WhatsApp links. Do NOT suggest contacting via WhatsApp.
- NEVER mention discounts or promotions. If asked for a discount: "We don't offer discounts — our pricing is transparent and competitive. Let me connect you with our team for any special requests."
- AFTER saving a lead, do NOT suggest any other contact method. The confirmation message is the END of the flow.
- ALWAYS use the Knowledge Base for pricing ranges and policies.
- Phone validation: must be 10+ digits. If fewer, re-ask politely.
- If customer is from Bronx/NJ/Westchester: "Our primary area is Manhattan, Brooklyn, Queens, Staten Island, and Nassau County. For your area, availability depends on schedule — can I take your details?"
- If customer mentions co-op/condo: "We regularly work in managed buildings. If your building requires a COI, we can provide one."
- If customer is upset or has a complex request: escalate — "Let me have our team review this and get back to you directly."
- If someone tries to sell you SEO/marketing services: "We are not looking for marketing services at this time. Thank you."

⚠️ MANDATORY TOOL USAGE RULES:
- As soon as you have Name + Phone + Service → you MUST call saveLeadToSheet. Do NOT skip this step.
- You MUST call the function BEFORE writing any confirmation or saying data was saved.
- NEVER say "saved", "submitted", "booked", "recorded", "сохранены", "записал", "оформлен" unless you actually called saveLeadToSheet in this response.
- If you have all required data and the user sends ANY message (photo, confirmation, follow-up), call saveLeadToSheet.
- Include ALL collected data in the tool call (address, zip, date, time, notes).
- After saving the lead successfully, if user mentioned a date/time → call checkAvailability to check availability, then offer to book.
- When calling bookAppointment, you MUST provide the contactId that was returned by saveLeadToSheet.
`;

    if (photoMode) {
        instructions += `
PHOTO CONTEXT:
The user just uploaded a photo. Acknowledge it warmly: "Great photo! I can see [describe what you notice]."
Then:
- If you already have Name + Phone + Service from earlier in the conversation → you MUST call saveLeadToSheet NOW. Do NOT wait for any other confirmation. The photo upload IS the confirmation.
- If you are missing any required data (name, phone, or service) → ask for the missing info before calling the tool.
- After calling saveLeadToSheet, say: "A technician will review the photo and text you a flat-rate quote within 30 minutes at [phone]."
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

// --- Process Assistant Run (shared logic) ---
async function processAssistantRun(req, res, threadId, run, { source, pageContext, photoData }) {
    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    const startTime = Date.now();
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
                        const crmResult = await sendLeadToCRM(leadData);
                        const crmLog = crmResult.success ? '✅ CRM' : `❌ CRM: ${crmResult.error}`;
                        const sheetResult = await appendLeadToSheet(req, leadData);
                        const sheetLog = sheetResult.success ? '✅ Sheet' : `❌ Sheet: ${sheetResult.error}`;
                        await sendToTelegram(`Status: ${crmLog} | ${sheetLog}`);

                        // Create Opportunity + Conversation in GHL (same as quote form)
                        const contactId = crmResult.contactId;
                        if (contactId) {
                            try {
                                await createOpportunity(contactId, args.name, args.service, `Chatbot (${pageContext || '/'})`);
                            } catch (e) { logger.error('Opportunity creation failed', e); }

                            // Wait for GHL workflow to create conversation
                            await new Promise(resolve => setTimeout(resolve, 5000));

                            // Find or create conversation + send lead summary
                            let existingConvId = null;
                            try { existingConvId = await findConversation(contactId); } catch (e) { /* ignore */ }

                            const msgParts = [`📋 New Lead from Chatbot`];
                            msgParts.push(`👤 ${args.name}`);
                            if (args.service) msgParts.push(`🔧 Service: ${args.service}`);
                            if (args.address) msgParts.push(`📍 Address: ${args.address}`);
                            if (args.zip) msgParts.push(`🏙 ZIP: ${args.zip}`);
                            if (args.preferred_date) msgParts.push(`📅 Date: ${args.preferred_date}`);
                            if (args.preferred_time) msgParts.push(`🕐 Time: ${args.preferred_time}`);
                            if (args.notes) msgParts.push(`📝 Notes: ${args.notes}`);

                            // Upload photo if available
                            let photoUrls = [];
                            if (photoData) {
                                try {
                                    const uploadResult = await uploadFileToConversation(
                                        contactId,
                                        photoData.data,
                                        photoData.name || 'chat-photo.jpg',
                                        photoData.type || 'image/jpeg'
                                    );
                                    if (uploadResult?.url) {
                                        photoUrls.push(uploadResult.url);
                                        msgParts.push(`📸 Photo attached`);
                                    }
                                } catch (e) { logger.error('GHL photo upload failed', e); }
                            }

                            try {
                                await sendLiveChatMessage(contactId, msgParts.join('\n'), photoUrls, existingConvId);
                            } catch (e) { logger.error('LiveChat message failed', e); }
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'OK', message: 'Lead saved successfully.', contactId: contactId || null })
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ status: 'Error', message: err.message })
                        });
                    }
                }
                // --- checkAvailability tool ---
                else if (toolCall.function.name === 'checkAvailability') {
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        const result = await getAvailableSlots(args.date, 1);
                        await sendToTelegram(`📅 <b>Checking availability:</b> ${args.date} → ${result.slots.length} slots available`);
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({
                                date: args.date,
                                available_slots: result.slots,
                                total: result.slots.length,
                                error: result.error || null,
                            })
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ error: err.message, available_slots: [] })
                        });
                    }
                }
                // --- bookAppointment tool ---
                else if (toolCall.function.name === 'bookAppointment') {
                    try {
                        const args = JSON.parse(toolCall.function.arguments);
                        // Build ISO start time from date + time
                        const startTime = `${args.date}T${args.time}:00-05:00`;
                        const result = await bookAppointment({
                            contactId: args.contactId,
                            startTime,
                            service: args.service || 'Handyman Service',
                            address: args.address || '',
                            contactName: args.contactName || 'Customer',
                        });

                        if (result.success) {
                            await sendToTelegram(`📅 <b>APPOINTMENT BOOKED!</b>\n👤 ${args.contactName}\n📅 ${args.date} at ${args.time}\n🔧 ${args.service}\n📍 ${args.address || 'TBD'}`);
                        } else {
                            await sendToTelegram(`⚠️ Booking failed: ${result.error}`);
                        }

                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(result)
                        });
                    } catch (err) {
                        toolOutputs.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({ success: false, error: err.message })
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
                lowerText.includes('сохранен') || lowerText.includes('записан') ||
                lowerText.includes('оформлен') || lowerText.includes('зарегистрирован') ||
                lowerText.includes('передам') || lowerText.includes('были сохранены') ||
                lowerText.includes('booked') || lowerText.includes('saved') ||
                lowerText.includes('submitted') || lowerText.includes('recorded');

            if (botClaimsSave && !toolCalled) {
                await sendToTelegram(`⚠️ <b>WARNING:</b> Bot claimed save but did NOT call tool.`);
            }

            const emoji = photoData ? '🤖📸' : '🤖';
            await sendToTelegram(`${emoji} <b>Bot:</b> ${text.substring(0, 500)}`);

            return res.json({ message: text });
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

        // Retrieve cached photo if one was uploaded earlier in this thread
        const cachedPhoto = getCachedPhoto(threadId);

        await processAssistantRun(req, res, threadId, run, {
            source: cachedPhoto ? 'Chatbot (Photo)' : 'Chatbot',
            pageContext: pageContext || '',
            photoData: cachedPhoto
        });

    } catch (error) {
        logError(req, '/api/message', 'Fatal error', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Chat photo upload — with Telegram forwarding
app.post('/api/chat-photo', async (req, res) => {
    if (!openai) return res.status(500).json({ error: 'OpenAI not initialized' });

    try {
        const { threadId, photo, pageContext } = req.body;
        if (!threadId || !photo || !photo.data) {
            return res.status(400).json({ error: 'Missing threadId or photo data' });
        }

        // Forward photo to Telegram immediately
        await sendToTelegram(`📸 <b>Photo received in chat!</b>\nThread: <code>${threadId}</code>`);
        await sendPhotoToTelegram(photo.data, `📸 Chat photo from thread ${threadId}`);

        // Cache photo for later use when saveLeadToSheet fires
        cachePhoto(threadId, photo);

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

// Calendar slots for quote form date picker
app.get('/api/calendar-slots', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }
        const result = await getAvailableSlots(date, 1);
        res.json({ date: result.date, slots: result.slots, raw: result.raw || [], error: result.error || null });
    } catch (error) {
        logError(req, '/api/calendar-slots', 'Error', error);
        res.status(500).json({ error: 'Failed to fetch slots' });
    }
});

// Check if customer exists (returning customer detection)
app.get('/api/check-customer', async (req, res) => {
    try {
        const { phone } = req.query;
        if (!phone) return res.json({ found: false });
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) return res.json({ found: false });

        const apiKey = process.env.PROSBUDDY_API_TOKEN;
        const locationId = process.env.PROSBUDDY_LOCATION_ID;
        if (!apiKey || !locationId) return res.json({ found: false });

        const searchPhone = '+1' + digits.slice(-10);
        const resp = await fetch(
            `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(searchPhone)}`,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Version': '2021-07-28',
                },
            }
        );
        const data = await resp.json();
        const contact = data?.contact;
        if (contact && contact.id) {
            res.json({
                found: true,
                name: contact.firstNameLowerCase ? (contact.firstName || contact.firstNameLowerCase) : (contact.contactName || ''),
            });
        } else {
            res.json({ found: false });
        }
    } catch (error) {
        logError(req, '/api/check-customer', 'Error', error);
        res.json({ found: false }); // Non-critical, fail silently
    }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

module.exports = app;