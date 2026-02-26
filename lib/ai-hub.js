// lib/ai-hub.js — Central AI Hub for Repair ASAP
// Handles: GHL webhook events, contact context, GPT-4o response generation, response delivery

const { OpenAI } = require('openai');
const config = require('./config');
const { buildSystemPrompt, formatConversationHistory } = require('./knowledge-base');
const { logger } = require('./utils/log');

// GHL API base
const GHL_API = 'https://services.leadconnectorhq.com';

// ---------- Response Delay Config (seconds) ----------
// [min, max] — randomized to appear human
// NOTE: GHL webhook timeout is ~30s. Total = delay + API calls (~3-5s) must be <30s
const RESPONSE_DELAYS = {
    yelp: { first: [8, 15], subsequent: [10, 20] },
    thumbtack: { first: [3, 8], subsequent: [5, 12] },
    sms: { first: [5, 10], subsequent: [8, 15] },
    voice: { first: [0, 0], subsequent: [0, 0] },
    webchat: { first: [0, 0], subsequent: [0, 0] },
};

// Owner cooldown: if owner sent a message within this many ms, bot stays silent
const OWNER_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------- GHL API Helpers ----------

async function ghlRequest(method, path, body = null) {
    const token = config.prosbuddy.apiToken;
    if (!token) throw new Error('PROSBUDDY_API_TOKEN not configured');

    const url = `${GHL_API}${path}`;
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
    };

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GHL API ${method} ${path} failed: ${res.status} ${errText}`);
    }
    return res.json();
}

// ---------- Contact Context ----------

/**
 * Get full contact context from GHL:
 * - Contact data (name, phone, email, tags, source)
 * - Conversation history (last 20 messages)
 */
async function getContactContext(contactId) {
    const context = {
        name: null,
        phone: null,
        email: null,
        source: null,
        tags: [],
        notes: null,
        conversationHistory: [],
    };

    try {
        // 1. Get contact data
        const contact = await ghlRequest('GET', `/contacts/${contactId}`);
        const c = contact.contact || contact;
        context.name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null;
        context.phone = c.phone || null;
        context.email = c.email || null;
        context.source = c.source || null;
        context.tags = c.tags || [];

        // 2. Get conversations for this contact
        try {
            const conversations = await ghlRequest(
                'GET',
                `/conversations/search?contactId=${contactId}&limit=1`
            );
            if (conversations.conversations && conversations.conversations.length > 0) {
                const convId = conversations.conversations[0].id;
                // Get messages from the conversation
                const messages = await ghlRequest(
                    'GET',
                    `/conversations/${convId}/messages?limit=20`
                );
                if (messages.messages) {
                    // Sort chronologically (oldest first) for the AI prompt
                    context.conversationHistory = messages.messages
                        .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded))
                        .map(m => ({
                            direction: m.direction, // 'inbound' or 'outbound'
                            body: m.body || m.message || '',
                            type: m.type, // SMS, Email, etc.
                            dateAdded: m.dateAdded,
                            ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
                        }))
                        .filter(m => m.body.length > 0);
                }
            }
        } catch (convErr) {
            logger.warn('Could not fetch conversation history', { error: convErr.message, contactId });
        }

        // 3. Get notes
        try {
            const notes = await ghlRequest('GET', `/contacts/${contactId}/notes`);
            if (notes.notes && notes.notes.length > 0) {
                context.notes = notes.notes.map(n => n.body).join('\n');
            }
        } catch (noteErr) {
            logger.warn('Could not fetch notes', { error: noteErr.message, contactId });
        }

    } catch (err) {
        logger.error('Failed to get contact context', { error: err.message, contactId });
        throw err;
    }

    return context;
}

// ---------- AI Response Generation ----------

/**
 * Generate AI response using GPT-4o with full context
 * Supports vision (image analysis) if attachments contain images
 */
async function generateAIResponse({ channel, contactContext, currentMessage, attachments }) {
    const openai = new OpenAI({ apiKey: config.openai.apiKey });
    const model = config.aiHub?.model || 'gpt-4o';

    // Build system prompt with KB + channel rules + contact context
    const systemPrompt = buildSystemPrompt(channel, contactContext);

    // Build message history for the conversation
    const formattedHistory = formatConversationHistory(contactContext.conversationHistory || []);

    // Build the current user message (with optional image)
    const userMessageContent = [];
    userMessageContent.push({ type: 'text', text: currentMessage });

    // If there are image attachments, add them for Vision
    if (attachments && attachments.length > 0) {
        for (const att of attachments) {
            if (att.url && (att.contentType?.startsWith('image/') || att.url.match(/\.(jpg|jpeg|png|webp|gif)$/i))) {
                userMessageContent.push({
                    type: 'image_url',
                    image_url: { url: att.url, detail: 'low' }, // 'low' for cost efficiency
                });
            }
        }
    }

    // Assemble messages array
    const messages = [
        { role: 'system', content: systemPrompt },
        ...formattedHistory,
        { role: 'user', content: userMessageContent.length === 1 ? currentMessage : userMessageContent },
    ];

    try {
        const completion = await openai.chat.completions.create({
            model,
            messages,
            max_tokens: 300,
            temperature: 0.7,
        });

        const response = completion.choices[0]?.message?.content || '';

        // Determine actions from the response
        const actions = determineActions(response, contactContext);

        return {
            message: response.trim(),
            actions,
            usage: {
                promptTokens: completion.usage?.prompt_tokens,
                completionTokens: completion.usage?.completion_tokens,
                totalTokens: completion.usage?.total_tokens,
                model,
            },
        };
    } catch (err) {
        logger.error('OpenAI API error', { error: err.message });
        throw err;
    }
}

// ---------- Action Detection ----------

function determineActions(responseText, contactContext) {
    const actions = [];
    const lower = responseText.toLowerCase();

    // Detect escalation
    if (lower.includes('team review') || lower.includes('get back to you personally') ||
        lower.includes('have our team') || lower.includes('someone will reach out')) {
        actions.push({ type: 'escalate', reason: 'AI escalated to human team' });
    }

    // Detect booking confirmation
    if (lower.includes('booked') || lower.includes('appointment') ||
        lower.includes('technician will confirm') || lower.includes('scheduled')) {
        actions.push({ type: 'notify_owner', reason: 'Booking mentioned in response' });
    }

    // Tag updates based on conversation stage
    if (contactContext && !contactContext.tags?.includes('AI-Engaged')) {
        actions.push({ type: 'add_tag', tag: 'AI-Engaged' });
    }

    return actions;
}

// ---------- Response Delivery ----------

/**
 * Send the AI-generated response back through GHL
 */
async function sendResponse({ contactId, conversationId, channel, message }) {
    try {
        // Send message through GHL Conversations API
        const result = await ghlRequest('POST', `/conversations/messages`, {
            type: channel === 'yelp' ? 'Yelp' : 'SMS',
            contactId,
            conversationId,
            message,
        });

        logger.info('Response sent via GHL', { contactId, channel, messageId: result.messageId });
        return result;
    } catch (err) {
        logger.error('Failed to send response', { error: err.message, contactId, channel });
        throw err;
    }
}

/**
 * Execute follow-up actions (tags, notes, notifications)
 */
async function executeActions(contactId, actions) {
    for (const action of actions) {
        try {
            switch (action.type) {
                case 'add_tag':
                    await ghlRequest('POST', `/contacts/${contactId}/tags`, {
                        tags: [action.tag],
                    });
                    logger.info('Tag added', { contactId, tag: action.tag });
                    break;

                case 'add_note':
                    await ghlRequest('POST', `/contacts/${contactId}/notes`, {
                        body: action.note,
                    });
                    break;

                case 'escalate':
                case 'notify_owner':
                    // Add a note so Nikita sees it in GHL
                    await ghlRequest('POST', `/contacts/${contactId}/notes`, {
                        body: `[AI HUB] ${action.reason}. Manual follow-up needed.`,
                    });
                    logger.info('Owner notified', { contactId, reason: action.reason });
                    break;
            }
        } catch (err) {
            logger.warn('Action execution failed', { action, error: err.message });
        }
    }
}

// ---------- Timing Helpers ----------

function randomDelay(min, max) {
    return min + Math.random() * (max - min);
}

async function applyHumanDelay(channel, isFirstBotMessage) {
    const delays = RESPONSE_DELAYS[channel] || RESPONSE_DELAYS.sms;
    const [min, max] = isFirstBotMessage ? delays.first : delays.subsequent;
    if (max <= 0) return 0;
    const delaySec = randomDelay(min, max);
    logger.info(`Applying human-like delay: ${delaySec.toFixed(1)}s`, { channel, isFirstBotMessage });
    await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
    return delaySec;
}

// ---------- Webhook Handler ----------

/**
 * Main webhook handler for GHL events
 * Receives: inbound message from any channel
 * Returns: AI response sent back to customer
 *
 * SAFETY FEATURES:
 * 1. Skips outbound (owner) messages
 * 2. Detects owner takeover (stays silent when owner is actively chatting)
 * 3. Applies human-like response delay
 */
async function handleWebhook(event) {
    const {
        type,           // 'InboundMessage' etc.
        contactId,
        conversationId,
        direction,      // 'inbound' = customer, 'outbound' = owner/team
        body: messageBody,
        message,
        channel,        // determined from event metadata
        attachments,
    } = event;

    // --- SAFETY CHECK 1: Skip outbound (owner) messages ---
    if (direction === 'outbound') {
        logger.info('Outbound message (owner), bot stays silent', { contactId });
        return { skipped: true, reason: 'Outbound message from owner/team' };
    }

    const currentMessage = messageBody || message || '';
    if (!currentMessage && (!attachments || attachments.length === 0)) {
        logger.warn('Empty message received, skipping', { contactId });
        return { skipped: true, reason: 'Empty message' };
    }

    // 1. Get full contact context from GHL
    const contactContext = await getContactContext(contactId);

    // --- SAFETY CHECK 2: Owner takeover detection ---
    // If owner recently sent a message in this conversation, bot stays silent
    const history = contactContext.conversationHistory;
    if (history.length > 0) {
        const lastOutbound = [...history]
            .reverse()
            .find(m => m.direction === 'outbound');

        if (lastOutbound && lastOutbound.dateAdded) {
            const lastOwnerTime = new Date(lastOutbound.dateAdded).getTime();
            const now = Date.now();
            const timeSinceOwner = now - lastOwnerTime;

            if (timeSinceOwner < OWNER_COOLDOWN_MS) {
                const minsAgo = Math.round(timeSinceOwner / 60000);
                logger.info(`Owner active ${minsAgo}min ago, bot stays silent`, { contactId });
                return {
                    skipped: true,
                    reason: `Owner was active ${minsAgo} minutes ago (cooldown: ${OWNER_COOLDOWN_MS / 60000}min)`,
                };
            }
        }
    }

    // --- SAFETY CHECK 3: Human-like response delay ---
    const botMessageCount = history.filter(m => m.direction === 'outbound').length;
    const isFirstBotMessage = botMessageCount === 0;
    const appliedDelay = await applyHumanDelay(channel || 'sms', isFirstBotMessage);

    // 2. Generate AI response with full context
    const aiResult = await generateAIResponse({
        channel: channel || 'sms',
        contactContext,
        currentMessage,
        attachments,
    });

    // 3. Message delivery handled by GHL workflow (not direct API)
    // The webhook returns the AI response in the body, and GHL's
    // "Send Yelp message" action picks it up from {{webhook.response.message}}
    // Direct API sending kept for future use (e.g., async mode):
    // if (conversationId && contactId) {
    //     await sendResponse({ contactId, conversationId, channel, message: aiResult.message });
    // }

    // 4. Execute follow-up actions (tags, notes, escalation notifications)
    if (aiResult.actions.length > 0) {
        await executeActions(contactId, aiResult.actions);
    }

    return {
        success: true,
        message: aiResult.message,
        actions: aiResult.actions,
        usage: aiResult.usage,
        timing: {
            delaySec: appliedDelay,
            isFirstBotMessage,
        },
    };
}

// ---------- Test Handler ----------

/**
 * Test endpoint -- simulates a conversation without sending real messages
 */
async function handleTest({ channel, customerName, message, contactId, dryRun, attachments }) {
    // If contactId provided, get real context; otherwise simulate
    let contactContext;
    if (contactId) {
        contactContext = await getContactContext(contactId);
    } else {
        contactContext = {
            name: customerName || 'Test Customer',
            phone: '+1 (555) 000-0000',
            email: null,
            source: channel || 'test',
            tags: [],
            notes: null,
            conversationHistory: [],
        };
    }

    // Generate AI response
    const aiResult = await generateAIResponse({
        channel: channel || 'yelp',
        contactContext,
        currentMessage: message || 'How much for TV mounting?',
        attachments: attachments || [],
    });

    return {
        dryRun: dryRun !== false,
        channel: channel || 'yelp',
        customerContext: {
            name: contactContext.name,
            source: contactContext.source,
            tags: contactContext.tags,
            historyLength: contactContext.conversationHistory.length,
        },
        aiResponse: aiResult.message,
        actions: aiResult.actions,
        usage: aiResult.usage,
    };
}

module.exports = {
    handleWebhook,
    handleTest,
    getContactContext,
    generateAIResponse,
    sendResponse,
    executeActions,
};
