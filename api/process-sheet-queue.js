// api/process-sheet-queue.js

// Используем обертку для Vercel Serverless Functions из QStash клиента
import { verifySignature } from "@upstash/qstash/dist/nextjs"; // Путь может немного отличаться, проверьте node_modules

// Импортируем нашу функцию записи в таблицу и утилиты
import { appendLeadToSheet } from '../lib/googleSheetService'; // Путь к вашему сервису
import { logInfo, logError, logger } from '../lib/utils/log'; // Путь к вашим логам

async function handler(req, res) {
    // Обертка verifySignature уже проверила подпись
    const context = '/api/process-sheet-queue';

    // Принимаем только POST запросы от QStash
    if (req.method !== 'POST') {
        logger.warn({ context, msg: `Method Not Allowed: ${req.method}` });
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    // Получаем ID сообщения из заголовков для логирования
    const qstashMessageId = req.headers['upstash-message-id'] || 'qstash-' + Date.now();
    const reqForLog = { id: qstashMessageId }; // Создаем простой объект для передачи в логгер

    try {
        const leadData = req.body; // QStash отправляет данные в теле как JSON
        logInfo(reqForLog, context, 'Received job from QStash', { data: leadData });

        if (!leadData || typeof leadData !== 'object') {
             logError(reqForLog, context, 'Invalid job data received from QStash', { body: req.body });
             // Отвечаем QStash ошибкой клиента (4xx), чтобы он не повторял бесполезный запрос
             return res.status(400).send('Bad Request: Invalid job data'); 
        }

        // Вызываем нашу функцию для записи в Google Sheets
        // Передаем reqForLog вместо полного req, так как полного req здесь нет
        const result = await appendLeadToSheet(reqForLog, leadData);

        if (result.success) {
            logInfo(reqForLog, context, 'Successfully processed job and added to sheet.');
            // Отвечаем QStash успехом (2xx)
            return res.status(200).send('OK: Lead processed');
        } else {
            logError(reqForLog, context, 'Failed to process job (appendLeadToSheet failed)', { error: result.error });
            // Отвечаем QStash ошибкой сервера (5xx), чтобы он ПОВТОРИЛ попытку позже
            return res.status(500).send('Internal Error: Failed to add lead to sheet');
        }

    } catch (error) {
        logError(reqForLog, context, 'Unexpected error processing QStash job', error);
        // Отвечаем QStash ошибкой сервера (5xx) для повторной попытки
        return res.status(500).send('Internal Server Error');
    }
}

// Оборачиваем наш handler функцией verifySignature
// Она автоматически проверит подпись, используя ключи из process.env
export default verifySignature(handler);