const { logger } = require('./utils/log');

/**
 * Upsert a lead into CRM (GoHighLevel / ProsBuddy).
 * Uses /contacts/upsert to handle duplicates gracefully.
 * Returns { success, contactId, error }.
 */
async function sendLeadToCRM(leadData) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    const locationId = process.env.PROSBUDDY_LOCATION_ID;

    if (!apiKey || !locationId) {
        logger.error('CRM Error: PROSBUDDY_API_TOKEN or PROSBUDDY_LOCATION_ID missing');
        return { success: false, error: 'CRM Config Missing' };
    }

    // Build payload — GHL /contacts/upsert does NOT accept 'notes' field
    const payload = {
        firstName: leadData.name,
        phone: leadData.phone,
        email: leadData.email || undefined,
        locationId,
        tags: leadData.tags || ['chatbot-lead', 'repair-asap-bot'],
        source: `Service: ${leadData.service || 'Not specified'}`,
    };

    // Remove undefined values
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    try {
        const response = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Version': '2021-07-28',
            },
            body: JSON.stringify(payload),
        });

        const responseText = await response.text();
        let data;
        try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }

        if (!response.ok) {
            logger.error('CRM API Error', { status: response.status, body: responseText });
            return { success: false, error: `CRM rejected: ${response.status}` };
        }

        const contactId = data?.contact?.id || data?.id || null;
        const isNew = data?.new === true;
        logger.info('CRM upsert OK', { contactId, isNew, name: leadData.name });
        return { success: true, contactId, isNew };

    } catch (error) {
        logger.error('Network error sending to CRM', error);
        return { success: false, error: error.message };
    }
}

module.exports = { sendLeadToCRM };