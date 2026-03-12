const express = require('express');
const { logInfo, logError, logger } = require('../lib/utils/log');
const { getAvailableSlots, bookAppointment } = require('../lib/calendarService');

const router = express.Router();

/**
 * Helper: Look up a contact in GHL by phone number
 */
async function lookupContactByPhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) return null;

    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    const searchPhone = '+1' + digits.slice(-10);
    try {
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
            return {
                id: contact.id,
                name: contact.firstNameLowerCase ? (contact.firstName || contact.firstNameLowerCase) : (contact.contactName || ''),
                email: contact.email || '',
                address: contact.address1 ? `${contact.address1}${contact.city ? ', ' + contact.city : ''}` : '',
                // If we need custom fields, we could fetch them here or extract from standard fields
            };
        }
    } catch (error) {
        logger.error('Error looking up contact for Vapi', error);
    }
    return null;
}

/**
 * POST /api/vapi/webhook
 * Unified endpoint for Vapi Server Events (assistant-request, end-of-call-report, etc.)
 */
router.post('/webhook', async (req, res) => {
    try {
        const payload = req.body;
        const type = payload?.message?.type;
        logger.info(`Vapi Webhook Received: ${type}`);

        // 1. Assistant Request (Before Call Starts) - Inject Context
        if (type === 'assistant-request') {
            const customerNumber = payload.message?.call?.customer?.number;
            let firstMessage = `Hi! This is Repair ASAP. How can I help you today?`;
            let customerName = '';
            let customerAddress = '';

            if (customerNumber) {
                const contact = await lookupContactByPhone(customerNumber);
                if (contact && contact.name) {
                    customerName = contact.name;
                    customerAddress = contact.address || '';
                    firstMessage = `Hi ${contact.name}, this is Anna from Repair ASAP! How can I help you today?`;
                }
            }

            // Return the specific Assistant ID and inject context into the System Prompt via overrides
            return res.json({
                assistantId: "2d0ec368-7ab0-4b0e-a516-78157cb96b0c",
                assistantOverrides: {
                    firstMessage: firstMessage,
                    variableValues: {
                        name: customerName,
                        address: customerAddress
                    }
                }
            });
        }

        // 2. End of Call Report - Save Transcript and Notify
        if (type === 'end-of-call-report') {
            const callData = payload.message;
            const customerNumber = callData.call?.customer?.number;
            const transcript = callData.artifact?.transcript || callData.transcript || '';
            const recordingUrl = callData.artifact?.recordingUrl || callData.recordingUrl || '';
            const summary = callData.analysis?.summary || callData.summary || '';

            logger.info('Call ended', { customerNumber, summary });

            // Send notification to Telegram
            const token = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_ADMIN_ID;
            if (token && chatId) {
                let safeTranscript = transcript ? transcript.substring(0, 3800) : 'No transcript';
                if (transcript.length > 3800) safeTranscript += '... [Truncated due to Telegram limits]';

                const tgMessage = `📞 <b>Vapi AI Call Ended</b>\nPhone: ${customerNumber || 'Unknown'}\n\n<b>Summary:</b>\n${summary || 'No summary'}\n\n<b>Recording:</b>\n${recordingUrl || 'No recording'}\n\n<b>Transcript:</b>\n${safeTranscript}`;
                try {
                    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: chatId, text: tgMessage, parse_mode: 'HTML' })
                    });
                } catch (e) {
                    logger.error('Telegram push failed', e);
                }
            }

            // Push a generic note to GHL CRM here, creating the contact if they don't exist
            if (customerNumber) {
                let contact = await lookupContactByPhone(customerNumber);
                let contactId = contact?.id;

                // Auto-create contact for callers who hung up before booking
                if (!contactId) {
                    const { sendLeadToCRM } = require('../lib/crmService');
                    const crmRes = await sendLeadToCRM({
                        name: 'Unknown Caller (Voice AI)',
                        phone: customerNumber,
                        service: 'General Inquiry',
                    });
                    if (crmRes.success) {
                        contactId = crmRes.contactId;
                    }
                }

                if (contactId) {
                    const apiKey = process.env.PROSBUDDY_API_TOKEN;
                    if (apiKey) {
                        try {
                            // 1. Add Note
                            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json',
                                    'Version': '2021-07-28'
                                },
                                body: JSON.stringify({
                                    body: `[Vapi AI Call]\nSummary: ${summary || 'None'}\nRecording: ${recordingUrl || 'None'}\nTranscript: ${transcript}`,
                                    userId: process.env.PROSBUDDY_LOCATION_ID
                                })
                            });

                            // 2. Add Internal Comment to Conversation history
                            await fetch(`https://services.leadconnectorhq.com/conversations/messages`, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${apiKey}`,
                                    'Content-Type': 'application/json',
                                    'Version': '2021-04-15'
                                },
                                body: JSON.stringify({
                                    type: 'InternalComment',
                                    contactId: contact.id,
                                    message: `📞 [Vapi AI Call Log]\nSummary: ${summary || 'None'}\nRecording: ${recordingUrl || 'None'}\nTranscript: ${transcript ? transcript.substring(0, 500) + '...' : ''}`
                                })
                            });
                        } catch (err) {
                            logger.error('Failed to add GHL note', err);
                        }
                    }
                }
            }

            // 3. Push transcript to Repair ASAP CRM
            if (customerNumber) {
                const crmBaseUrl = process.env.CRM_BASE_URL; // e.g. https://repair-asap-crm-production.up.railway.app
                if (crmBaseUrl) {
                    try {
                        const durationSeconds = callData.call?.duration || callData.duration || 0;
                        const durationMin = Math.floor(durationSeconds / 60);
                        const durationSec = durationSeconds % 60;
                        const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSeconds}s`;

                        const crmPayload = {
                            from: customerNumber,
                            callSid: callData.call?.id || '',
                            transcript: transcript || '',
                            summary: summary || '',
                            recordingUrl: recordingUrl || '',
                            duration: durationStr,
                            source: 'vapi',
                        };

                        const crmResponse = await fetch(`${crmBaseUrl}/api/twilio/voice/transcript`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(crmPayload),
                        });

                        if (crmResponse.ok) {
                            logger.info('VAPI transcript pushed to CRM', { customerNumber });
                        } else {
                            logger.warn('CRM transcript push failed', { status: crmResponse.status });
                        }
                    } catch (crmErr) {
                        logger.error('Failed to push VAPI transcript to CRM', crmErr);
                    }
                }
            }

            return res.json({ success: true });
        }

        // 3. Other Events - Acknowledge safely
        return res.json({ success: true });

    } catch (e) {
        logError(req, '/api/vapi/webhook', 'Webhook processing failed', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Parses a date string or day of the week into a properly formatted YYYY-MM-DD in the future.
 */
function parseNaturalDate(input) {
    if (!input) return null;
    const lowerInput = String(input).toLowerCase().trim();
    // Get current NYC time
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));

    if (lowerInput === 'today') return now.toISOString().split('T')[0];

    if (lowerInput === 'tomorrow') {
        const t = new Date(now);
        t.setDate(t.getDate() + 1);
        return t.toISOString().split('T')[0];
    }

    // Handle conversational broad week queries
    if (lowerInput === 'this week' || lowerInput === 'any day this week' || lowerInput === 'this weekend') {
        return now.toISOString().split('T')[0];
    }

    if (lowerInput === 'next week') {
        // Find next monday
        const t = new Date(now);
        let daysToMonday = 1 - t.getDay(); // 0 is Sunday
        if (daysToMonday <= 0) daysToMonday += 7;
        t.setDate(t.getDate() + daysToMonday);
        return t.toISOString().split('T')[0];
    }

    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDayIndex = now.getDay(); // 0 is Sunday

    let targetDayIndex = -1;
    for (let i = 0; i < days.length; i++) {
        if (lowerInput.includes(days[i])) {
            targetDayIndex = i;
            break;
        }
    }

    if (targetDayIndex !== -1) {
        let daysToAdd = targetDayIndex - currentDayIndex;
        if (daysToAdd <= 0) {
            daysToAdd += 7; // It's past this week's occurrence, move to next week
        }

        if (lowerInput.includes('next ')) {
            daysToAdd += 7;
        }

        const t = new Date(now);
        t.setDate(t.getDate() + daysToAdd);
        return t.toISOString().split('T')[0];
    }

    // We NO LONGER accept YYYY-MM-DD here. The routes will catch it and throw a strict error.
    return null;
}

/**
 * POST /api/vapi/calendar
 * Called by Vapi as a Custom Tool to check available slots.
 */
router.post('/calendar', async (req, res) => {
    logInfo(req, '/api/vapi/calendar', 'Vapi Calendar Request', { body: req.body });
    try {
        const { message } = req.body;
        // If it's a tool call, Vapi passes arguments inside message.toolCalls[0].function.arguments
        const toolCall = message?.toolCalls?.[0];
        if (!toolCall) return res.json({ error: 'No tool call provided' });

        let args = {};
        try {
            args = typeof toolCall.function.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : (toolCall.function.arguments || {});
        } catch (e) {
            logger.error('Failed to parse calendar tool arguments', e);
        }

        const rawDate = args.date;

        // Strict Rejection of AI's YYYY-MM-DD hallucination habit
        if (typeof rawDate === 'string' && rawDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: DO NOT send dates in YYYY-MM-DD format. You MUST send the exact natural language string the user said, such as "this week", "next week", "Wednesday", or "tomorrow".'
                }]
            });
        }

        const date = parseNaturalDate(rawDate); // Supports "Wednesday", "this week", etc.

        if (!date) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not understand the date format. Please pass a valid natural language timeframe like "this week", "next week", "Wednesday" or "tomorrow". DO NOT use YYYY-MM-DD.'
                }]
            });
        }

        const avail = await getAvailableSlots(date, 1);

        res.json({
            results: [{
                toolCallId: toolCall.id,
                result: `Available slots for ${date}: ${avail.slots.length > 0 ? avail.slots.join(', ') : 'None'}`
            }]
        });
    } catch (e) {
        logError(req, '/api/vapi/calendar', 'Calendar check failed', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/vapi/book
 * Called by Vapi Custom Tool to actually schedule the appointment.
 */
router.post('/book', async (req, res) => {
    logInfo(req, '/api/vapi/book', 'Vapi Booking Request', { body: req.body });
    try {
        const { message } = req.body;
        const toolCall = message?.toolCalls?.[0];
        if (!toolCall) return res.json({ error: 'No tool call provided' });

        let args = {};
        try {
            args = typeof toolCall.function.arguments === 'string'
                ? JSON.parse(toolCall.function.arguments)
                : (toolCall.function.arguments || {});
        } catch (e) {
            logger.error('Failed to parse book tool arguments', e);
        }

        const { time, service, address, name } = args;
        let { date, phone } = args;

        // Format or Auto-correct phone number
        if (phone) {
            // Strip everything except digits
            const digits = phone.replace(/\D/g, '');
            if (digits.length >= 10) {
                // Take the last 10 digits and prepend +1 formatting
                phone = '+1' + digits.slice(-10);
            } else {
                phone = null; // Formatting failed
            }
        }

        // Fallback to the actual incoming caller ID if AI didn't ask or provided garbage
        if (!phone && req.body.message?.call?.customer?.number) {
            phone = req.body.message.call.customer.number;
        }

        // Strict Rejection of AI's YYYY-MM-DD hallucination habit
        if (typeof date === 'string' && date.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: DO NOT send dates in YYYY-MM-DD format. You MUST send natural language like "this week", "next week", "Wednesday" or "tomorrow". Calculate the day of the week the user meant.'
                }]
            });
        }

        // Parse date from natural language
        date = parseNaturalDate(date);
        if (!date) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not understand the date format. Please pass a valid natural language timeframe like "this week", "next week", "Wednesday" or "tomorrow".'
                }]
            });
        }

        // Ensure we have a contact ID to book against (upsert the contact)
        let contactId = null;
        if (phone) {
            const { sendLeadToCRM } = require('../lib/crmService');
            const crmRes = await sendLeadToCRM({
                name: name || 'Caller',
                phone: phone,
                service: service || 'Handyman',
                address: address || undefined
            });
            if (crmRes.success) {
                contactId = crmRes.contactId;
            }
        }

        if (!contactId) {
            return res.json({
                results: [{
                    toolCallId: toolCall.id,
                    result: 'Error: Could not find or create a contact to book against. Cannot book appointment.'
                }]
            });
        }

        const startTime = `${date}T${time}:00-05:00`;
        const bookingResult = await bookAppointment({
            contactId,
            startTime,
            service: service || 'Handyman Service',
            address: address || '',
            contactName: name || 'Customer'
        });

        const replyMsg = bookingResult.success
            ? `Successfully booked appointment for ${date} at ${time}.`
            : `Failed to book appointment: ${bookingResult.error}`;

        res.json({
            results: [{
                toolCallId: toolCall.id,
                result: replyMsg
            }]
        });

    } catch (e) {
        logError(req, '/api/vapi/book', 'Booking call failed', e);
        res.status(500).json({ error: e.message });
    }
});



/**
 * POST /api/vapi/outbound
 * Triggered by GoHighLevel Workflows (e.g., Abandoned form, "Call me" text)
 */
router.post('/outbound', async (req, res) => {
    try {
        const { firstName, phone, context } = req.body;
        logger.info('Received outbound call request from GHL', { firstName, phone, context });

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // 1. Format phone to strict +1XXXXXXXXXX (E.164)
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10) {
            return res.status(400).json({ error: 'Invalid phone number length' });
        }
        const formattedPhone = '+1' + digits.slice(-10);

        // 2. Fetch VAPI Private Key
        const apiKey = process.env.VAPI_PRIVATE_API_KEY;
        if (!apiKey) {
            logger.error('VAPI_PRIVATE_API_KEY is not set in environment variables');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        // 3. Construct prompt overlay to give Anna context about WHY she is calling
        const overrideMessage = context
            ? `Hi ${firstName || 'there'}, this is Anna from Repair ASAP. You requested a callback regarding: ${context}. How can I help you today?`
            : `Hi ${firstName || 'there'}, this is Anna from Repair ASAP. How can I help you today?`;

        // 4. Hit Vapi Outbound API
        const vapiResponse = await fetch('https://api.vapi.ai/call/phone', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                assistantId: '2d0ec368-7ab0-4b0e-a516-78157cb96b0c',
                customer: {
                    number: formattedPhone,
                    name: firstName || 'Customer'
                },
                assistantOverrides: {
                    firstMessage: overrideMessage
                }
            })
        });

        if (!vapiResponse.ok) {
            const errData = await vapiResponse.text();
            logger.error('Vapi outbound call failed', errData);
            return res.status(vapiResponse.status).json({ error: 'Failed to initiate call via Vapi', details: errData });
        }

        const data = await vapiResponse.json();
        logger.info('Successfully initiated Vapi outbound call', { callId: data.id });
        res.status(200).json({ success: true, callId: data.id });

    } catch (e) {
        logError(req, '/api/vapi/outbound', 'Outbound webhook failed', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
