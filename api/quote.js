// api/quote.js — Quote Form API Route for Vercel
// Handles form submissions with optional photo uploads,
// creates a contact in GHL CRM, and uploads photos to GHL Media.

const { sendLeadToCRM } = require('../lib/crmService');
const { logger } = require('../lib/utils/log');

// GHL API base URL
const GHL_API = 'https://services.leadconnectorhq.com';

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
        };

        const crmResult = await sendLeadToCRM(leadData);

        if (crmResult.success) {
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
