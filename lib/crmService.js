const { logger } = require('./utils/log');

/**
 * Отправляет лид напрямую в CRM (GoHighLevel / ProsBuddy)
 */
async function sendLeadToCRM(leadData) {
    const apiKey = process.env.PROSBUDDY_API_TOKEN;
    // Используем стандартный API LeadConnector (GoHighLevel)
    const apiUrl = 'https://services.leadconnectorhq.com/contacts/'; 
    
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
        tags: ['chatbot-lead', 'repair-asap-bot'], // Теги, чтобы ты видел источник
        customFields: [
            // Если нужно передать услугу как кастомное поле, 
            // нужно знать ID поля. Пока пишем в notes.
        ],
        notes: `Service Requested: ${leadData.service}. Notes: ${leadData.notes || ''}`
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

        logger.info('Successfully sent lead to CRM', { response: responseText });
        return { success: true };

    } catch (error) {
        logger.error('Network error sending to CRM', error);
        return { success: false, error: error.message };
    }
}

module.exports = { sendLeadToCRM };