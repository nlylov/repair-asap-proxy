// lib/config.js

// Загружаем .env.local только для локальной разработки
// Убедись, что .env.local находится в КОРНЕ проекта, а не в api/ или lib/
if (process.env.NODE_ENV !== 'production') {
  try {
    // Используем path для надежного пути к .env.local из корня проекта
    require('dotenv').config({ path: require('path').resolve(__dirname, '../.env.local') });
  } catch (err) {
    console.warn('dotenv config failed (normal in production, error if local):', err.message);
  }
}

// List of allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://asap.repair',
  'https://www.asap.repair',
  'https://api.asap.repair',
  'https://sitehandy.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];

const config = {
  // Конфигурация OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    assistantId: process.env.OPENAI_ASSISTANT_ID,
  },
  // Конфигурация Google Sheets (для временной интеграции)
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    // Важно: читаем как строку, парсить будем в googleSheetService
    serviceAccountCredsJson: process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS,
  },
  // Конфигурация ProsBuddy CRM
  prosbuddy: {
    apiUrl: process.env.PROSBUDDY_API_URL || 'https://services.leadconnectorhq.com',
    apiToken: process.env.PROSBUDDY_API_TOKEN,
    apiVersion: '2021-07-28',
    locationId: process.env.PROSBUDDY_LOCATION_ID,
  },
  // Настройки CORS
  cors: {
    allowedOrigins: ALLOWED_ORIGINS,
    options: {
      origin: function (origin, callback) {
        // Allow requests with no origin (server-to-server, curl, mobile apps)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Version', 'Location-Id', 'X-Request-ID'],
      credentials: true
    }
  },
  // Уровень логирования
  logLevel: process.env.LOG_LEVEL || 'info',
};

// --- Проверка наличия критически важных переменных ---
let hasConfigError = false;
if (!config.openai.apiKey) {
  console.error('CONFIG ERROR: OPENAI_API_KEY environment variable is not set.');
  hasConfigError = true;
}
if (!config.openai.assistantId) {
  console.error('CONFIG ERROR: OPENAI_ASSISTANT_ID environment variable is not set.');
  hasConfigError = true;
}
if (!config.google.sheetId) {
  console.error('CONFIG ERROR: GOOGLE_SHEET_ID environment variable is not set.');
  hasConfigError = true;
}
if (!config.google.serviceAccountCredsJson) {
  console.error('CONFIG ERROR: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS environment variable is not set.');
  hasConfigError = true;
}
if (!config.prosbuddy.apiToken) {
  console.warn('CONFIG WARN: PROSBUDDY_API_TOKEN environment variable is not set.');
}

module.exports = config;