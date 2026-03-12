// api/process-sheet-queue.js (Исправленная версия с CommonJS)

// Используем require вместо import
const { verifySignature } = require("@upstash/qstash/dist/nextjs"); 
const { appendLeadToSheet } = require('../lib/googleSheetService'); 
const { logInfo, logError, logger } = require('../lib/utils/log'); 

async function handler(req, res) {
    // Обертка verifySignature должна проверить подпись ДО вызова этого хендлера
    const context = '/api/process-sheet-queue';

    // Принимаем только POST запросы от QStash
    if (req.method !== 'POST') {
        logger.warn({ context, msg: `Method Not Allowed: ${req.method}` });
        res.setHeader('Allow', 'POST');
        // Используем return, чтобы завершить выполнение здесь
        return res.status(405).end('Method Not Allowed'); 
    }

    // Получаем ID сообщения из заголовков для логирования
    // req && req.headers нужен для безопасности, т.к. req может быть неполным при ошибках
    const qstashMessageId = (req && req.headers && req.headers['upstash-message-id']) || 'qstash-' + Date.now();
    const reqForLog = { id: qstashMessageId }; // Создаем простой объект для передачи в логгер

    try {
        // req.body парсится автоматически Vercel/Express для JSON
        const leadData = req.body; 
        logInfo(reqForLog, context, 'Received job from QStash', { data: leadData });

        if (!leadData || typeof leadData !== 'object') {
             logError(reqForLog, context, 'Invalid job data received from QStash', { body: req.body });
             return res.status(400).send('Bad Request: Invalid job data'); 
        }

        // Вызываем нашу функцию для записи в Google Sheets
        // Передаем reqForLog вместо полного req
        const result = await appendLeadToSheet(reqForLog, leadData);

        if (result.success) {
            logInfo(reqForLog, context, 'Successfully processed job and added to sheet.');
            return res.status(200).send('OK: Lead processed');
        } else {
            logError(reqForLog, context, 'Failed to process job (appendLeadToSheet failed)', { error: result.error });
            return res.status(500).send('Internal Error: Failed to add lead to sheet');
        }

    } catch (error) {
        logError(reqForLog, context, 'Unexpected error processing QStash job', error);
        return res.status(500).send('Internal Server Error');
    }
}

// Оборачиваем наш handler функцией verifySignature
// Используем module.exports вместо export default
module.exports = verifySignature(handler);