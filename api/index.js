// api/index.js
const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

// Настройка CORS для вашего домена
app.use(cors({
  origin: ['https://asap.repair', 'https://www.asap.repair', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// OpenAI прокси
app.use('/v1', createProxyMiddleware({
  target: 'https://api.openai.com',
  changeOrigin: true,
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('Authorization', `Bearer ${process.env.OPENAI_API_KEY}`);
  }
}));

// Простой эндпоинт для проверки работоспособности
app.get('/', (req, res) => {
  res.send('Прокси-сервер работает!');
});

// Эндпоинт для проверки переменных окружения (без раскрытия ключей)
app.get('/check-env', (req, res) => {
  res.json({
    assistantId: process.env.OPENAI_ASSISTANT_ID ? 'Настроен' : 'Не настроен',
    apiKey: process.env.OPENAI_API_KEY ? 'Настроен' : 'Не настроен'
  });
});

module.exports = app;
