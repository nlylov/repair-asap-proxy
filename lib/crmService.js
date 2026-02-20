const { logger } = require('./utils/log');

/**
 * Отправляет лид напрямую в CRM (GoHighLevel / ProsBuddy)
 */
async function sendLeadToCRM(leadData) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    // Upsert: creates new contact or updates existing (prevents 422 on duplicates)
    const apiUrl = 'https://services.leadconnectorhq.com/contacts/upsert';

    if (!apiKey) {
        logger.error('CRM Error: PROSBUDDY_API_TOKEN is missing in Vercel env');
        return { success: false, error: 'CRM Config Missing' };
    }

    // Формируем тело запроса для GHL
    // Важно: GHL любит чистые телефоны (+1...)
    const payload = {
        firstName: leadData.name,
        phone: leadData.phone,
        email: leadData.email || '',
        locationId: process.env.PROSBUDDY_LOCATION_ID,
        tags: leadData.tags || ['chatbot-lead', 'repair-asap-bot'],
        source: leadData.notes || `Service: ${leadData.service}`,
        companyName: leadData.service || '',
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28' // Стабильная версия API GHL
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();

        if (!response.ok) {
            logger.error('CRM API Error', { status: response.status, body: responseText });
            return { success: false, error: `CRM rejected: ${response.status}` };
        }

        // Parse response to extract contactId
        let contactId = null;
        try {
            const parsed = JSON.parse(responseText);
            contactId = parsed.contact?.id || parsed.id || null;
        } catch (e) {
            // Response might not be JSON
        }

        logger.info('Successfully sent lead to CRM', { contactId, response: responseText });
        return { success: true, contactId };

    } catch (error) {
        logger.error('Network error sending to CRM', error);
        return { success: false, error: error.message };
    }
}

module.exports = { sendLeadToCRM };