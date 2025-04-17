// lib/googleSheetService.js (Версия с googleapis)

// --- Импорты ---
const { google } = require('googleapis'); // Используем новую библиотеку
const { JWT } = require('google-auth-library'); // JWT все еще нужен для аутентификации
const config = require('./config');
const { logInfo, logError } = require('./utils/log');
// ---------------

// --- Загрузка Credentials и Sheet ID ---
const SHEET_ID = config.google.sheetId;
console.log(`!!! googleSheetService loaded. Initial SHEET_ID type: ${typeof SHEET_ID}, value: ${SHEET_ID}`);
let SERVICE_ACCOUNT_CREDS;
try {
    SERVICE_ACCOUNT_CREDS = JSON.parse(config.google.serviceAccountCredsJson);
    if (!SERVICE_ACCOUNT_CREDS || !SERVICE_ACCOUNT_CREDS.client_email || !SERVICE_ACCOUNT_CREDS.private_key) {
        throw new Error('Service account credentials JSON is incomplete.');
    }
} catch (e) {
    logError(null, 'googleSheetService:init', 'FATAL: Failed to parse GOOGLE_SERVICE_ACCOUNT_CREDENTIALS JSON', e);
    SERVICE_ACCOUNT_CREDS = null; // Устанавливаем в null, чтобы проверка ниже сработала
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

// --- Основная функция добавления лида (переписана под googleapis) ---
async function appendLeadToSheet(req, leadData) {
    const context = 'googleSheetService:appendLeadDirect'; // Обновим контекст для логов

    // Проверка конфига
    if (!SERVICE_ACCOUNT_CREDS?.client_email || !SERVICE_ACCOUNT_CREDS?.private_key) {
        logError(req, context, 'Config Error: Google Sheets credentials incomplete');
        return { success: false, error: 'Google Sheets configuration incomplete' };
    }
    if (!SHEET_ID) {
         logError(req, context, 'Config Error: SHEET_ID is missing!');
         return { success: false, error: 'Google Sheets configuration error: SHEET_ID missing' };
    }

    try {
        logInfo(req, context, 'Step 1: Initializing JWT Auth client...');
        const auth = new JWT({
            email: SERVICE_ACCOUNT_CREDS.client_email,
            key: SERVICE_ACCOUNT_CREDS.private_key.replace(/\\n/g, '\n'),
            scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Только этот scope нужен для append
        });
        logInfo(req, context, 'Step 2: JWT Auth client Initialized.');

        logInfo(req, context, 'Step 3: Initializing Google Sheets API client (v4)...');
        const sheets = google.sheets({ version: 'v4', auth });
        logInfo(req, context, 'Step 4: Google Sheets API client created.');

        // --- Подготовка данных для API ---
        const timestamp = leadData.timestamp || new Date().toISOString();
        // ВАЖНО: Данные должны быть МАССИВОМ МАССИВОВ. Каждый внутренний массив - строка.
        // Порядок элементов должен ТОЧНО соответствовать порядку колонок в вашем range (см. ниже)
        const newRowArray = [
            timestamp,                          // Колонка A: Timestamp
            formatReadableDate(timestamp),      // Колонка B: CreatedAt
            leadData.source || 'Unknown',       // Колонка C: Source
            leadData.name || '',                // Колонка D: Name
            leadData.phone || '',               // Колонка E: Phone
            leadData.email || '',               // Колонка F: Email
            leadData.address || '',             // Колонка G: Address
            leadData.service || '',             // Колонка H: Service
            leadData.notes || ''                // Колонка I: Notes
            // Добавьте/уберите/поменяйте порядок колонок здесь, если ваша таблица отличается
        ];
        const valuesToAppend = [ newRowArray ]; // Оборачиваем массив строки в еще один массив
        // --------------------------------

        // --- ВАЖНО: УКАЖИТЕ ПРАВИЛЬНЫЙ ДИАПАЗОН ---
        // Укажите имя вашего листа и диапазон колонок, куда писать
        // Пример: 'Лист1!A:I' или 'Sheet1!A:I'
        const targetRange = 'Лист1!A:I'; // <--- ЗАМЕНИТЕ 'Лист1' НА ИМЯ ВАШЕГО ЛИСТА, ЕСЛИ ОНО ДРУГОЕ
                                         //      И УБЕДИТЕСЬ, ЧТО КОЛОНКИ (A:I) СООТВЕТСТВУЮТ ДАННЫМ В newRowArray
        // ------------------------------------------
        logInfo(req, context, `Step 5: Preparing to append values to range: ${targetRange}`, { data: newRowArray });


        // --- Вызов API для добавления строки ---
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: targetRange,
            valueInputOption: 'USER_ENTERED', // Обрабатывать значения как введенные пользователем (например, для форматов дат/чисел)
            insertDataOption: 'INSERT_ROWS', // Вставлять как новые строки
            resource: {
                values: valuesToAppend,
            },
        });
        // -------------------------------------

        logInfo(req, context, 'Step 6: Row appended successfully via API.', { apiResponse: response.data });
        return { success: true };

    } catch (error) {
        // Ловим любую ошибку
        // Ошибки от Google API часто содержат полезные детали в error.response.data или error.errors
        logError(req, context, 'Failed during Google Sheet API operation', error);
        // Попробуем извлечь более детальную ошибку от Google, если она есть
        const googleApiError = error.errors ? JSON.stringify(error.errors) : error.message;
        return { success: false, error: googleApiError || 'Unknown Google Sheets API error' };
    }
}
// ------------------------------------

// --- Экспорт ---
module.exports = { appendLeadToSheet };
// -------------