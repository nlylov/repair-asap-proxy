const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

// Initialize Express app
const app = express();

// Check environment variables
if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(1);
}

if (!process.env.OPENAI_ASSISTANT_ID) {
  console.error('OPENAI_ASSISTANT_ID is not set');
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// CORS configuration
const allowedOrigins = [
  'https://asap.repair',
  'https://www.asap.repair',
  'https://api.asap.repair',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS policy violation'), false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Parse JSON requests
app.use(express.json());

// Специально для файла chat.js
app.get('/chat.js', (req, res) => {
  const filePath = path.join(__dirname, '..', 'public', 'chat.js');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Chat script not found');
  }
});

// Специально для файла test.js
app.get('/test.js', (req, res) => {
  const filePath = path.join(__dirname, '..', 'public', 'test.js');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(filePath);
  } else {
    res.status(404).send('Test script not found');
  }
});

// Обслуживание статических файлов из директории public
app.use(express.static(path.join(__dirname, '..', 'public')));

// Create a new thread
app.post('/api/thread', async (req, res) => {
  try {
    const thread = await openai.beta.threads.create();
    res.json({ threadId: thread.id });
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Send message and get response
app.post('/api/message', async (req, res) => {
  try {
    const { threadId, message } = req.body;
    
    if (!threadId || !message) {
      return res.status(400).json({ error: 'Thread ID and message are required' });
    }
    
    // Add message to thread
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message
    });
    
    // Run the assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID
    });
    
    // Poll for completion
    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    
    const startTime = Date.now();
    const timeoutMs = 30000;
    
    while (runStatus.status === 'in_progress' || runStatus.status === 'queued') {
      if (Date.now() - startTime > timeoutMs) {
        return res.status(504).json({ error: 'Request timed out' });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    }
    
    if (runStatus.status !== 'completed') {
      return res.status(500).json({ error: `Run failed with status: ${runStatus.status}` });
    }
    
    const messages = await openai.beta.threads.messages.list(threadId);
    const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
    
    if (!assistantMessage) {
      return res.status(404).json({ error: 'No response found' });
    }
    
    const messageContent = assistantMessage.content[0].text.value;
    res.json({ message: messageContent });
  } catch (error) {
    console.error('Error processing message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

module.exports = app;
