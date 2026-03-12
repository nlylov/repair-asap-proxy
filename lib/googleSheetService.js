// lib/googleSheetService.js (Версия с googleapis, АДАПТИРОВАННАЯ под 57 колонок)

// --- Импорты ---
const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const config = require('./config');
const { logInfo, logError } = require('./utils/log');
// ---------------

// --- Загрузка Credentials и Sheet ID ---
const SHEET_ID = config.google.sheetId; // ID НОВОЙ таблицы из Vercel env vars
console.log(`!!! googleSheetService loaded. Initial SHEET_ID type: ${typeof SHEET_ID}, value: ${SHEET_ID}`);
let SERVICE_ACCOUNT_CREDS;
try {
    SERVICE_ACCOUNT_CREDS = JSON.parse(config.google.serviceAccountCredsJson);
    if (!SERVICE_ACCOUNT_CREDS || !SERVICE_ACCOUNT_CREDS.client_email || !SERVICE_ACCOUNT_CREDS.private_key) {
        throw new Error('Service account credentials JSON is incomplete.');
    }
} catch (e) {
    logError(null, 'googleSheetService:init', 'FATAL: Failed to parse GOOGLE_SERVICE_ACCOUNT_CREDENTIALS JSON', e);
    SERVICE_ACCOUNT_CREDS = null;
}
// ------------------------------------

// --- Функция форматирования даты ---
function formatReadableDate(isoTimestamp) {
     if (!isoTimestamp) return '';
     try {
         return new Date(isoTimestamp).toLocaleString('en-US', {
             timeZone: 'America/New_York',
             year: 'numeric', month: 'short', day: 'numeric',
             hour: 'numeric', minute: '2-digit', hour12: true
         });
     } catch (e) {
         logError(null, 'formatReadableDate', 'Failed to format date', e, { isoTimestamp });
         return '';
     }
}
// ----------------------------------

// --- Основная функция добавления лида ---
async function appendLeadToSheet(req, leadData) {
    const context = 'googleSheetService:appendLeadDirect';
    const reqId = req?.id || 'GSheetService-' + Date.now();

    // Проверка конфига
    if (!SERVICE_ACCOUNT_CREDS?.client_email || !SERVICE_ACCOUNT_CREDS?.private_key) {
        logError({id: reqId}, context, 'Config Error: Google Sheets credentials incomplete');
        return { success: false, error: 'Google Sheets configuration incomplete' };
    }
    if (!SHEET_ID) {
         logError({id: reqId}, context, 'Config Error: SHEET_ID is missing!');
         return { success: false, error: 'Google Sheets configuration error: SHEET_ID missing' };
    }

    try {
        // --- Шаги 1-4: Аутентификация и создание клиента ---
        logInfo({id: reqId}, context, 'Step 1-2: Initializing JWT Auth client...');
        const auth = new JWT({
            email: SERVICE_ACCOUNT_CREDS.client_email,
            key: SERVICE_ACCOUNT_CREDS.private_key.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        logInfo({id: reqId}, context, 'Step 3-4: Initializing Google Sheets API client (v4)...');
        const sheets = google.sheets({ version: 'v4', auth });
        logInfo({id: reqId}, context, 'Steps 1-4: Auth and Sheets API client created.');

        // --- Подготовка данных для API в НУЖНОМ ПОРЯДКЕ (A-BE, 57 колонок) ---
        const timestamp = leadData.timestamp || new Date().toISOString();
        const createdAt = formatReadableDate(timestamp);
        const vercelReqId = req?.id || ''; // ID запроса Vercel для отладки

        // Создаем массив нужной длины (57) и заполняем его пустыми строками
        const newRowArray = Array(57).fill('');

        // Заполняем известные значения по индексам (A=0, B=1, ...)
        // На основе списка: Timestamp,CreatedAt,Source,Name,Phone,Email,address,Service,Notes,
        // date_time,Status,Assigned_To,CRM_Link,ac_type,...,outdoor_ready,
        // referer,formid,sent,requestid,SMS Sent Timestamp
        newRowArray[0] = timestamp;                   // A: Timestamp
        newRowArray[1] = createdAt;                   // B: CreatedAt
        newRowArray[2] = leadData.source || 'Chatbot';// C: Source
        newRowArray[3] = leadData.name || '';         // D: Name
        newRowArray[4] = leadData.phone || '';        // E: Phone
        newRowArray[5] = leadData.email || '';        // F: Email
        newRowArray[6] = leadData.address || '';      // G: address
        newRowArray[7] = leadData.service || '';      // H: Service
        newRowArray[8] = leadData.notes || '';        // I: Notes
        // J: date_time - Оставляем пустым (индекс 9)
        // K: Status - Оставляем пустым (индекс 10)
        // L: Assigned_To - Оставляем пустым (индекс 11)
        // M: CRM_Link - Оставляем пустым (индекс 12)
        // N-BC (Индексы 13-54) - Tilda/Service Specific - Оставляем пустыми
        newRowArray[55] = vercelReqId;                // BD: requestid (Индекс 55)
        // BE: SMS Sent Timestamp - Оставляем пустым (индекс 56)

        const valuesToAppend = [ newRowArray ];
        // -------------------------------------------------------

        // --- Диапазон A-BE ---
        // !!! ВАЖНО: Замените 'Лист1' на реальное имя вашего листа, если оно другое !!!
        const targetRange = 'Лист1!A:BE'; // <--- ОБНОВЛЕННЫЙ ДИАПАЗОН (57 колонок)
        // --------------------
        logInfo({id: reqId}, context, `Step 5: Preparing to append values to range: ${targetRange}`);

        // --- Вызов API для добавления строки ---
        logInfo({id: reqId}, context, 'Step 5b: Calling sheets.spreadsheets.values.append...');
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: targetRange,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: valuesToAppend,
            },
        });
        // -------------------------------------

        logInfo({id: reqId}, context, 'Step 6: Row appended successfully via API.', { apiResponseUpdates: response.data?.updates });
        return { success: true };

    } catch (error) {
        logError({id: reqId}, context, 'Failed during Google Sheet API operation', error, { leadDataAttempted: leadData ? { name: leadData.name, phone: leadData.phone } : null });
        const googleApiError = error.errors ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: googleApiError || 'Unknown Google Sheets API error' };
    }
}
// ------------------------------------

// --- Экспорт ---
module.exports = { appendLeadToSheet };
// -------------