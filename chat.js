/**
 * Repair ASAP Chatbot для Tilda
 * Версия для прямой интеграции на сайт Tilda
 */

// Ждем полной загрузки страницы
document.addEventListener('DOMContentLoaded', function() {
  // Создаем контейнер для чат-бота, если его еще нет
  if (!document.getElementById('repair-asap-chatbot')) {
    const chatbotContainer = document.createElement('div');
    chatbotContainer.id = 'repair-asap-chatbot';
    document.body.appendChild(chatbotContainer);
  }
  
  // Инициализируем чат-бот
  initRepairASAPChatbot();
});

function initRepairASAPChatbot() {
  // Настройки чат-бота
  const config = {
    proxyUrl: 'https://api.asap.repair',
    containerSelector: '#repair-asap-chatbot',
    primaryColor: '#0066CC'
  };
  
  let threadId = null;
  let isInitialized = false;
  let messageQueue = [];
  let envData = null;
  
  // Создаем UI чат-бота
  createChatUI();
  
  // Инициализируем соединение с API
  init();
  
  async function init() {
    try {
      // Проверка настроек сервера
      const envCheck = await fetch(`${config.proxyUrl}/check-env`);
      envData = await envCheck.json();
      
      if (!envData.assistantId || !envData.apiKey) {
        console.error('Ошибка: Переменные окружения на сервере не настроены');
        return;
      }
      
      // Создание нового потока (thread)
      const threadResponse = await fetch(`${config.proxyUrl}/v1/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!threadResponse.ok) {
        throw new Error('Не удалось создать поток для чата');
      }
      
      const threadData = await threadResponse.json();
      threadId = threadData.id;
      isInitialized = true;
      
      // Обработка сообщений, которые были в очереди
      if (messageQueue.length > 0) {
        for (const message of messageQueue) {
          await sendMessage(message);
        }
        messageQueue = [];
      }
      
      console.log('Чат-бот успешно инициализирован');
    } catch (error) {
      console.error('Ошибка инициализации чат-бота:', error);
    }
  }
  
  async function sendMessage(message) {
    if (!isInitialized) {
      // Если чат-бот еще не инициализирован, добавляем сообщение в очередь
      messageQueue.push(message);
      return { status: 'queued', message: 'Сообщение в очереди' };
    }
    
    try {
      // Добавление сообщения в поток
      const messageResponse = await fetch(`${config.proxyUrl}/v1/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'user',
          content: message
        })
      });
      
      if (!messageResponse.ok) {
        throw new Error('Не удалось отправить сообщение');
      }
      
      // Запуск ассистента
      const runResponse = await fetch(`${config.proxyUrl}/v1/threads/${threadId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistant_id: envData.assistantId
        })
      });
      
      if (!runResponse.ok) {
        throw new Error('Не удалось запустить ассистента');
      }
      
      const runData = await runResponse.json();
      
      // Ожидание завершения выполнения
      return await waitForCompletion(runData.id);
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
      return { error: 'Не удалось получить ответ от чат-бота' };
    }
  }
  
  async function waitForCompletion(runId) {
    let status = 'in_progress';
    
    while (status === 'in_progress' || status === 'queued') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const response = await fetch(`${config.proxyUrl}/v1/threads/${threadId}/runs/${runId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        throw new Error('Не удалось получить статус выполнения');
      }
      
      const data = await response.json();
      status = data.status;
      
      if (status === 'completed') {
        return await getMessages();
      }
      
      if (status === 'failed' || status === 'cancelled') {
        return { error: `Выполнение ${status}` };
      }
    }
  }
  
  async function getMessages() {
    const response = await fetch(`${config.proxyUrl}/v1/threads/${threadId}/messages`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      throw new Error('Не удалось получить сообщения');
    }
    
    const data = await response.json();
    // Возвращаем последнее сообщение от ассистента
    const assistantMessages = data.data.filter(msg => msg.role === 'assistant');
    
    if (assistantMessages.length === 0) {
      return { error: 'Нет ответа от ассистента' };
    }
    
    return {
      content: assistantMessages[0].content[0].text.value,
      messageId: assistantMessages[0].id
    };
  }
  
  // Создание UI чат-бота
  function createChatUI() {
    const container = document.querySelector(config.containerSelector);
    if (!container) {
      console.error(`Контейнер ${config.containerSelector} не найден`);
      return;
    }
    
    // Создание HTML для чат-бота
    container.innerHTML = `
      <div class="chatbot-widget" style="display: none;">
        <div class="chatbot-header" style="background-color: ${config.primaryColor};">
          <h3>Repair ASAP Ассистент</h3>
          <button class="chatbot-close">×</button>
        </div>
        <div class="chatbot-messages"></div>
        <div class="chatbot-input">
          <input type="text" placeholder="Введите ваш вопрос...">
          <button style="background-color: ${config.primaryColor};">Отправить</button>
        </div>
      </div>
      <button class="chatbot-toggle" style="background-color: ${config.primaryColor};">
        <span>💬</span>
      </button>
    `;
    
    // Добавление стилей
    const style = document.createElement('style');
    style.textContent = `
      .chatbot-widget {
        position: fixed;
        bottom: 80px;
        right: 20px;
        width: 350px;
        height: 500px;
        background: #fff;
        border-radius: 10px;
        box-shadow: 0 5px 25px rgba(0, 0, 0, 0.2);
        display: flex;
        flex-direction: column;
        font-family: 'Montserrat', sans-serif;
        z-index: 9999;
        overflow: hidden;
      }
      
      .chatbot-header {
        color: white;
        padding: 15px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .chatbot-header h3 {
        margin: 0;
        font-size: 16px;
      }
      
      .chatbot-close {
        background: none;
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
      }
      
      .chatbot-messages {
        flex: 1;
        overflow-y: auto;
        padding: 15px;
        display: flex;
        flex-direction: column;
      }
      
      .message {
        max-width: 80%;
        padding: 10px 15px;
        margin-bottom: 10px;
        border-radius: 18px;
        line-height: 1.4;
      }
      
      .message.user {
        background: #e6f2ff;
        align-self: flex-end;
        border-bottom-right-radius: 5px;
      }
      
      .message.bot {
        background: #f0f0f0;
        align-self: flex-start;
        border-bottom-left-radius: 5px;
      }
      
      .chatbot-input {
        display: flex;
        padding: 10px;
        border-top: 1px solid #e0e0e0;
      }
      
      .chatbot-input input {
        flex: 1;
        padding: 10px;
        border: 1px solid #e0e0e0;
        border-radius: 20px;
        font-family: 'Montserrat', sans-serif;
      }
      
      .chatbot-input button {
        color: white;
        border: none;
        padding: 10px 15px;
        margin-left: 10px;
        border-radius: 20px;
        cursor: pointer;
      }
      
      .chatbot-toggle {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        cursor: pointer;
        border: none;
        box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
        z-index: 9999;
      }
    `;
    
    document.head.appendChild(style);
    
    // Добавление обработчиков событий
    const widget = container.querySelector('.chatbot-widget');
    const toggle = container.querySelector('.chatbot-toggle');
    const close = container.querySelector('.chatbot-close');
    const input = container.querySelector('.chatbot-input input');
    const sendButton = container.querySelector('.chatbot-input button');
    const messages = container.querySelector('.chatbot-messages');
    
    // Переключение видимости чат-бота
    toggle.addEventListener('click', () => {
      widget.style.display = 'flex';
      toggle.style.display = 'none';
      
      // Добавление приветственного сообщения, если чат пуст
      if (messages.children.length === 0) {
        addMessage('Здравствуйте! Я ассистент Repair ASAP. Чем могу помочь вам сегодня?', 'bot');
      }
    });
    
    close.addEventListener('click', () => {
      widget.style.display = 'none';
      toggle.style.display = 'flex';
    });
    
    // Отправка сообщения
    const handleSendMessage = async () => {
      const messageText = input.value.trim();
      if (!messageText) return;
      
      // Добавление сообщения пользователя в UI
      addMessage(messageText, 'user');
      input.value = '';
      
      // Индикатор набора текста
      const typingIndicator = document.createElement('div');
      typingIndicator.className = 'message bot typing';
      typingIndicator.textContent = 'Печатает...';
      messages.appendChild(typingIndicator);
      messages.scrollTop = messages.scrollHeight;
      
      // Получение ответа от чат-бота
      try {
        const response = await sendMessage(messageText);
        
        // Удаление индикатора набора текста
        messages.removeChild(typingIndicator);
        
        if (response.error) {
          addMessage('Извините, произошла ошибка. Пожалуйста, попробуйте позже.', 'bot');
        } else {
          addMessage(response.content, 'bot');
        }
      } catch (error) {
        messages.removeChild(typingIndicator);
        addMessage('Извините, произошла ошибка. Пожалуйста, попробуйте позже.', 'bot');
      }
    };
    
    sendButton.addEventListener('click', handleSendMessage);
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSendMessage();
    });
  }
  
  // Метод для добавления сообщения в UI
  function addMessage(text, sender) {
    const container = document.querySelector(config.containerSelector);
    if (!container) return;
    
    const messages = container.querySelector('.chatbot-messages');
    if (!messages) return;
    
    const messageElement = document.createElement('div');
    messageElement.className = `message ${sender}`;
    messageElement.textContent = text;
    messages.appendChild(messageElement);
    messages.scrollTop = messages.scrollHeight;
  }
}
