// api/quote.js — Quote Form API Route for Vercel
// Handles form submissions with optional photo uploads,
// creates a contact in GHL CRM, creates an Opportunity in the pipeline,
// and sends photos into the contact's Conversation thread.

const { sendLeadToCRM } = require('../lib/crmService');
const { bookAppointment } = require('../lib/calendarService');
const { logger } = require('../lib/utils/log');

// GHL API base URL
const GHL_API = 'https://services.leadconnectorhq.com';

// Cache pipeline info to avoid repeated API calls
let cachedPipelineInfo = null;

/**
 * Fetch the first pipeline and its first stage from GHL.
 * Results are cached in memory for the lambda lifecycle.
 */
async function getPipelineInfo() {
    if (cachedPipelineInfo) return cachedPipelineInfo;

    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    try {
        const response = await fetch(`${GHL_API}/opportunities/pipelines?locationId=${locationId}`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-07-28',
            },
        });

        if (!response.ok) {
            logger.error('Failed to fetch pipelines', { status: response.status });
            return null;
        }

        const data = await response.json();
        const pipelines = data.pipelines || [];

        if (pipelines.length === 0) {
            logger.error('No pipelines found in GHL');
            return null;
        }

        const pipeline = pipelines[0];
        const firstStage = pipeline.stages?.[0];

        if (!firstStage) {
            logger.error('No stages found in pipeline', { pipelineId: pipeline.id });
            return null;
        }

        cachedPipelineInfo = {
            pipelineId: pipeline.id,
            pipelineStageId: firstStage.id,
            pipelineName: pipeline.name,
            stageName: firstStage.name,
        };

        logger.info('Pipeline info loaded', cachedPipelineInfo);
        return cachedPipelineInfo;

    } catch (err) {
        logger.error('Error fetching pipeline info', err);
        return null;
    }
}

/**
 * Create an Opportunity in GHL pipeline linked to a contact.
 */
async function createOpportunity(contactId, contactName, service, source) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    const pipelineInfo = await getPipelineInfo();
    if (!pipelineInfo) {
        logger.error('Cannot create opportunity: no pipeline info');
        return null;
    }

    try {
        const opportunityName = `Lead | Website | ${contactName}`;

        const payload = {
            pipelineId: pipelineInfo.pipelineId,
            pipelineStageId: pipelineInfo.pipelineStageId,
            locationId: locationId,
            contactId: contactId,
            name: opportunityName,
            status: 'open',
            source: 'Website Quote Form',
            monetaryValue: 0,
        };

        const response = await fetch(`${GHL_API}/opportunities/`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28',
            },
            body: JSON.stringify(payload),
        });

        if (response.ok) {
            const data = await response.json();
            logger.info('Opportunity created', {
                id: data.opportunity?.id,
                name: opportunityName,
                stage: pipelineInfo.stageName
            });
            return data.opportunity;
        } else {
            const errText = await response.text();
            logger.error('Opportunity creation failed', { status: response.status, body: errText });
            return null;
        }
    } catch (err) {
        logger.error('Opportunity creation error', err);
        return null;
    }
}

/**
 * Upload a single file to GHL Conversations via multipart upload.
 * Uses POST /conversations/messages/upload
 * Returns the uploaded file URL on success, null on failure.
 */
async function uploadFileToConversation(contactId, base64Data, fileName, mimeType) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    try {
        const fileBuffer = Buffer.from(base64Data, 'base64');
        const CRLF = '\r\n';
        const boundary = '----FormBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);

        // Build multipart body parts as buffers
        const parts = [];

        // --- contactId field ---
        parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="contactId"${CRLF}${CRLF}` +
            `${contactId}${CRLF}`
        ));

        // --- locationId field ---
        parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="locationId"${CRLF}${CRLF}` +
            `${locationId}${CRLF}`
        ));

        // --- file attachment ---
        parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="fileAttachment"; filename="${fileName}"${CRLF}` +
            `Content-Type: ${mimeType}${CRLF}${CRLF}`
        ));
        parts.push(fileBuffer);
        parts.push(Buffer.from(CRLF));

        // --- closing boundary ---
        parts.push(Buffer.from(`--${boundary}--${CRLF}`));

        const bodyBuffer = Buffer.concat(parts);

        const response = await fetch(`${GHL_API}/conversations/messages/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-07-28',
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: bodyBuffer,
        });

        const respText = await response.text();
        let respData;
        try { respData = JSON.parse(respText); } catch { respData = respText; }

        if (response.ok) {
            // GHL returns { uploadedFiles: { "filename": "url" } }
            const files = respData?.uploadedFiles;
            let url = null;
            if (files && typeof files === 'object') {
                // Get the first file URL from the dict
                const urls = Object.values(files);
                url = urls[0] || null;
            }
            // Fallback to older formats
            if (!url) url = respData?.urls?.[0] || respData?.url || respData?.fileUrl || null;
            logger.info('File uploaded to conversation', { fileName, url });
            return { url, raw: respData };
        } else {
            logger.error('Conversation file upload failed', {
                status: response.status,
                body: respText,
                fileName
            });
            return { url: null, error: response.status, body: respData };
        }
    } catch (err) {
        logger.error('Conversation file upload error', { fileName, error: err.message });
        return { url: null, error: err.message };
    }
}

/**
 * Search for an existing conversation for a contact.
 * Returns the conversationId or null.
 */
async function findConversation(contactId) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;
    if (!apiKey || !locationId) return null;

    try {
        const response = await fetch(
            `${GHL_API}/conversations/search?contactId=${contactId}&locationId=${locationId}`,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Version': '2021-07-28',
                },
            }
        );
        const data = await response.json();
        // Prefer the phone/SMS conversation
        const convs = data.conversations || [];
        const smsConv = convs.find(c =>
            c.type === 'TYPE_PHONE' || c.lastMessageType === 'TYPE_SMS'
        );
        return smsConv?.id || convs[0]?.id || null;
    } catch (err) {
        logger.error('Find conversation error', err);
        return null;
    }
}

/**
 * Send a Live_Chat message into the contact's conversation thread.
 * Uses POST /conversations/messages with type "Live_Chat".
 * If conversationId is provided, sends to that specific thread.
 */
async function sendLiveChatMessage(contactId, text, attachmentUrls, conversationId) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    if (!apiKey) return null;

    try {
        const payload = {
            type: 'Live_Chat',
            contactId: contactId,
            message: text || '',
        };

        // Send to existing conversation if we found one
        if (conversationId) {
            payload.conversationId = conversationId;
        }

        if (attachmentUrls && attachmentUrls.length > 0) {
            payload.attachments = attachmentUrls;
        }

        const response = await fetch(`${GHL_API}/conversations/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28',
            },
            body: JSON.stringify(payload),
        });

        const respText = await response.text();
        let respData;
        try { respData = JSON.parse(respText); } catch { respData = respText; }

        if (response.ok) {
            logger.info('Live_Chat message sent to conversation', {
                contactId,
                conversationId: respData.conversationId,
                messageId: respData.messageId,
                attachments: attachmentUrls?.length || 0,
            });
            return { ok: true, data: respData };
        } else {
            logger.error('Live_Chat message failed', {
                status: response.status,
                body: respText,
            });
            return { ok: false, status: response.status, error: respData };
        }
    } catch (err) {
        logger.error('Live_Chat message error', err);
        return { ok: false, error: err.message };
    }
}

/**
 * Main handler for POST /api/quote
 */
async function handleQuoteSubmission(req, res) {
    try {
        const { name, phone, email, zip, service, date, message, photos, time, address } = req.body;

        // Validate required fields
        if (!name || !phone) {
            return res.status(400).json({
                error: 'Name and phone are required'
            });
        }

        // Validate email format if provided
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                error: 'Invalid email format'
            });
        }

        // ═══════════════════════════════════════════════════════
        // STEP 1: Forward to NEW CRM (PRIMARY — awaited)
        // ═══════════════════════════════════════════════════════
        const newCrmUrl = process.env.NEW_CRM_WEBHOOK_URL || 'https://crm.asap.repair/api/webhooks/website';
        const newCrmSecret = process.env.NEW_CRM_WEBHOOK_SECRET;
        let crmOk = false;
        let crmContactId = null;
        if (newCrmSecret) {
            try {
                const crmRes = await fetch(newCrmUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Secret': newCrmSecret,
                    },
                    body: JSON.stringify({ name, phone, email, zip, service, date, message, address }),
                });
                if (crmRes.ok) {
                    const crmData = await crmRes.json();
                    crmOk = true;
                    crmContactId = crmData.contactId || null;
                    logger.info('Lead sent to new CRM', { name, phone, contactId: crmContactId });
                } else {
                    logger.error('New CRM webhook failed', { status: crmRes.status });
                }
            } catch (err) {
                logger.error('New CRM webhook error', { error: err.message });
            }
        }

        // ═══════════════════════════════════════════════════════
        // STEP 2: GHL contact + opportunity (BACKGROUND — fully fire-and-forget)
        // No longer needed for booking — CRM handles calendar now
        // ═══════════════════════════════════════════════════════
        if (!crmOk) {
            // Fallback: if CRM failed, try GHL
            const noteParts = [];
            noteParts.push('📋 Source: Website Quote Form');
            if (service) noteParts.push(`🔧 Service: ${service}`);
            if (zip) noteParts.push(`📍 ZIP: ${zip}`);
            if (date) noteParts.push(`📅 Preferred Date: ${date}`);
            if (message) noteParts.push(`💬 Message: ${message}`);

            const leadData = {
                name, phone, email: email || '',
                service: service || 'Not specified',
                notes: noteParts.join('\n\n'),
                tags: ['quote-form', 'website-lead'],
            };

            const crmResult = await sendLeadToCRM(leadData);
            if (!crmResult.success) {
                logger.error('Both CRM systems failed', { error: crmResult.error });
                return res.status(500).json({
                    error: 'Failed to submit quote. Please try again or call us.'
                });
            }
            // GHL Opportunity — background
            if (crmResult.contactId) {
                (async () => {
                    try { await createOpportunity(crmResult.contactId, name, service, 'Website Quote Form'); }
                    catch (e) { logger.error('GHL Opportunity (bg)', e); }
                })();
            }
        } else {
            // CRM succeeded — GHL is fully fire-and-forget background
            (async () => {
                try {
                    const leadData = {
                        name, phone, email: email || '',
                        service: service || 'Not specified',
                        notes: '📋 Source: Website Quote Form',
                        tags: ['quote-form', 'website-lead'],
                    };
                    const r = await sendLeadToCRM(leadData);
                    if (r.success && r.contactId) {
                        await createOpportunity(r.contactId, name, service, 'Website Quote Form');
                    }
                } catch (e) { logger.error('GHL background sync error', e); }
            })();
        }

        // ═══════════════════════════════════════════════════════
        // STEP 3: Calendar booking (uses CRM calendar, not GHL)
        // ═══════════════════════════════════════════════════════
        let bookingResult = null;
        if (date && time) {
            try {
                bookingResult = await bookAppointment({
                    contactId: crmContactId || null,
                    startTime: time,
                    service: service || 'Handyman Service',
                    address: address || (zip ? `ZIP: ${zip}` : ''),
                    contactName: name,
                });
                if (bookingResult.success) {
                    logger.info('Quote form: appointment booked', {
                        appointmentId: bookingResult.appointmentId,
                        startTime: time,
                    });
                } else {
                    logger.error('Quote form: booking failed', { error: bookingResult.error });
                }
            } catch (bookErr) {
                logger.error('Quote form: booking error (non-critical)', bookErr);
            }
        }

        logger.info('Quote submission successful', {
            name, phone, service,
            crmOk,
            ghlOk: crmResult.success,
            booked: bookingResult?.success || false,
        });
        return res.json({
            success: true,
            message: bookingResult?.success
                ? `Quote request received and appointment booked!`
                : 'Quote request received successfully',
            booked: bookingResult?.success || false,
        });

    } catch (error) {
        logger.error('Quote submission error', error);
        if (!res.headersSent) {
            return res.status(500).json({
                error: 'Server error. Please try calling us at +1 (775) 310-7770.'
            });
        }
    }
}

module.exports = handleQuoteSubmission;
module.exports.uploadFileToConversation = uploadFileToConversation;
module.exports.findConversation = findConversation;
module.exports.sendLiveChatMessage = sendLiveChatMessage;
module.exports.createOpportunity = createOpportunity;
