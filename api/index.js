// api/index.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

// Разрешаем парсинг JSON
app.use(bodyParser.json());

// Настраиваем CORS для всех запросов
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Обработка предварительных запросов OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Маршрут для чата
app.post('/api/chat', (req, res) => {
  console.log('Получен запрос:', req.body);
  
  // Получаем сообщение из тела запроса
  const message = req.body.message || 'Привет';
  const conversationId = req.body.conversationId || '';
  
  // Отправляем ответ
  res.json({
    response: "Это тестовый ответ от прокси-сервера. Ваше сообщение: " + message,
    conversationId: conversationId || "new_conversation_123"
  });
});

// Маршрут для проверки работы сервера
app.get('/', (req, res) => {
  res.send('Прокси-сервер работает!');
});

// Маршрут для проверки API
app.get('/api/chat', (req, res) => {
  res.json({ status: 'ok', message: 'API работает' });
});

// Экспортируем приложение для Vercel
module.exports = app;