// api/quote.js — Quote Form API Route for Vercel
// Handles form submissions with optional photo uploads,
// creates a contact in GHL CRM, creates an Opportunity in the pipeline,
// and uploads photos to GHL Media.

const { sendLeadToCRM } = require('../lib/crmService');
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

        // Use the first pipeline, first stage ("New Lead" typically)
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
 * Upload a single file (base64) to GHL Media Storage
 * Returns the file URL on success, null on failure
 */
async function uploadToGHLMedia(base64Data, fileName, mimeType) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    if (!apiKey) return null;

    try {
        // Convert base64 to a Buffer
        const fileBuffer = Buffer.from(base64Data, 'base64');

        // Build multipart form data manually
        const boundary = '----FormBoundary' + Date.now().toString(36);
        const bodyParts = [];

        // File part
        bodyParts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
            `Content-Type: ${mimeType}\r\n\r\n`
        );
        bodyParts.push(fileBuffer);
        bodyParts.push('\r\n');

        // hosted field (required by GHL)
        bodyParts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="hosted"\r\n\r\n` +
            `true\r\n`
        );

        // fileUrl field (name for the file)
        bodyParts.push(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="fileUrl"\r\n\r\n` +
            `quote-photos/${Date.now()}-${fileName}\r\n`
        );

        bodyParts.push(`--${boundary}--\r\n`);

        // Combine into single Buffer
        const bodyBuffer = Buffer.concat(
            bodyParts.map(part => typeof part === 'string' ? Buffer.from(part) : part)
        );

        const response = await fetch(`${GHL_API}/medias/upload-file`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-07-28',
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: bodyBuffer,
        });

        if (response.ok) {
            const data = await response.json();
            logger.info('File uploaded to GHL Media', { fileName, url: data.url });
            return data.url || data.fileUrl || null;
        } else {
            const errText = await response.text();
            logger.error('GHL Media upload failed', { status: response.status, body: errText });
            return null;
        }
    } catch (err) {
        logger.error('GHL Media upload error', err);
        return null;
    }
}

/**
 * Main handler for POST /api/quote
 */
async function handleQuoteSubmission(req, res) {
    try {
        const { name, phone, email, service, date, message, photos } = req.body;

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

        // Upload photos if provided (max 5, each max ~7MB base64 ≈ 5MB file)
        let photoUrls = [];
        if (photos && Array.isArray(photos) && photos.length > 0) {
            const maxPhotos = Math.min(photos.length, 5);
            const uploadPromises = photos.slice(0, maxPhotos).map((photo, i) => {
                const { data, name: photoName, type } = photo;
                if (!data || !type) return Promise.resolve(null);

                // Validate size (~7MB base64 ≈ 5MB file)
                if (data.length > 7 * 1024 * 1024) return Promise.resolve(null);

                return uploadToGHLMedia(data, photoName || `photo-${i + 1}.jpg`, type);
            });

            const results = await Promise.allSettled(uploadPromises);
            photoUrls = results
                .filter(r => r.status === 'fulfilled' && r.value)
                .map(r => r.value);
        }

        // Build notes with service details and photo URLs
        const noteParts = [];
        noteParts.push('📋 Source: Website Quote Form');
        if (service) noteParts.push(`🔧 Service: ${service}`);
        if (date) noteParts.push(`📅 Preferred Date: ${date}`);
        if (message) noteParts.push(`💬 Message: ${message}`);
        if (photoUrls.length > 0) {
            noteParts.push(`📸 Photos (${photoUrls.length}):\n${photoUrls.join('\n')}`);
        }

        // Send to CRM using existing service
        const leadData = {
            name: name,
            phone: phone,
            email: email || '',
            service: service || 'Not specified',
            notes: noteParts.join('\n\n'),
            tags: ['quote-form', 'website-lead'],
        };

        const crmResult = await sendLeadToCRM(leadData);

        if (crmResult.success) {
            // Extract contactId from the CRM response to create an Opportunity
            const contactId = crmResult.contactId;

            if (contactId) {
                // Create Opportunity in pipeline (non-blocking — don't fail if this fails)
                try {
                    await createOpportunity(contactId, name, service, 'Website Quote Form');
                } catch (oppErr) {
                    logger.error('Opportunity creation failed (non-critical)', oppErr);
                }
            }

            logger.info('Quote submission successful', {
                name, phone, service, photoCount: photoUrls.length
            });
            return res.json({
                success: true,
                message: 'Quote request received successfully'
            });
        } else {
            logger.error('CRM submission failed', { error: crmResult.error });
            return res.status(500).json({
                error: 'Failed to submit quote. Please try again or call us.'
            });
        }

    } catch (error) {
        logger.error('Quote submission error', error);
        return res.status(500).json({
            error: 'Server error. Please try calling us at +1 (775) 310-7770.'
        });
    }
}

module.exports = handleQuoteSubmission;
