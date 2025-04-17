// public/chat.js (Финальная версия для деплоя)

(function() {
  // --- Конфигурация ---
  const config = {
    // Используем пустую строку для относительных запросов на том же домене
    // Это будет работать и с локальным тестированием, и с Vercel деплоем
    apiEndpoint: '', // Пустая строка для запросов к текущему домену
    //apiEndpoint: 'http://localhost:3000', // Раскомментируй для локального теста
    // apiEndpoint: 'https://api.asap.repair', // Раскомментируй для конкретного домена API
    primaryColor: '#0066CC',
    fontFamily: 'Montserrat, sans-serif',
  };
  const containerId = 'repair-asap-chatbot';
  // --------------------

  let state = { threadId: null, messages: [], isOpen: false, isLoading: false };

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #repair-asap-chatbot-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: ${config.fontFamily}; }
      #repair-asap-chat-button { width: 60px; height: 60px; border-radius: 50%; background-color: ${config.primaryColor}; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); transition: all 0.3s ease; }
      #repair-asap-chat-button:hover { transform: scale(1.05); }
      #repair-asap-chat-button svg { width: 30px; height: 30px; }
      #repair-asap-chat-window { position: absolute; bottom: 70px; right: 0; width: 350px; height: 500px; background-color: white; border-radius: 10px; box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2); display: flex; flex-direction: column; overflow: hidden; transition: all 0.3s ease; opacity: 0; transform: translateY(20px); pointer-events: none; }
      #repair-asap-chat-window.open { opacity: 1; transform: translateY(0); pointer-events: all; }
      #repair-asap-chat-header { background-color: ${config.primaryColor}; color: white; padding: 15px; display: flex; justify-content: space-between; align-items: center; }
      #repair-asap-chat-header h3 { margin: 0; font-size: 16px; }
      #repair-asap-chat-close { cursor: pointer; background: none; border: none; color: white; font-size: 20px; line-height: 1; }
      #repair-asap-chat-messages { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
      .chat-message { max-width: 80%; padding: 10px 15px; border-radius: 15px; margin-bottom: 5px; word-wrap: break-word; line-height: 1.4; font-size: 14px;}
      .user-message { background-color: #E9F5FF; color: #333; align-self: flex-end; border-bottom-right-radius: 5px; }
      .bot-message { background-color: #F2F2F2; color: #333; align-self: flex-start; border-bottom-left-radius: 5px; }
      .bot-message a { color: ${config.primaryColor}; text-decoration: underline; }
      #repair-asap-chat-input-container { padding: 15px; border-top: 1px solid #eee; display: flex; gap: 10px; }
      #repair-asap-chat-input { flex: 1; padding: 10px 15px; border: 1px solid #ddd; border-radius: 20px; outline: none; font-size: 14px; font-family: ${config.fontFamily}; }
      #repair-asap-chat-input:focus { border-color: ${config.primaryColor}; }
      #repair-asap-chat-send { background-color: ${config.primaryColor}; color: white; border: none; border-radius: 20px; padding: 10px 15px; cursor: pointer; font-size: 14px; font-family: ${config.fontFamily}; }
      #repair-asap-chat-send:disabled { background-color: #ccc; cursor: not-allowed; }
      .loading-indicator { display: flex; align-items: center; padding: 10px 15px; color: #666; font-style: italic; font-size: 13px; }
      .loading-dots { display: inline-flex; margin-left: 5px; }
      .loading-dots span { width: 6px; height: 6px; margin: 0 2px; background-color: #666; border-radius: 50%; animation: loading-dots 1.4s infinite ease-in-out both; }
      .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
      .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
      @keyframes loading-dots { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
      .error-message { color: #e74c3c; text-align: center; padding: 10px; margin: 10px; border: 1px solid #e74c3c; border-radius: 5px; background-color: #fadbd8; font-size: 13px; }
    `;
    document.head.appendChild(style);
  }

  function createChatUI() {
    const container = document.getElementById(containerId);
    if (!container) {
       console.error(`Chatbot container with ID "${containerId}" not found.`);
       return;
    }
    const chatContainer = document.createElement('div');
    chatContainer.id = 'repair-asap-chatbot-container';
    const chatButton = document.createElement('div');
    chatButton.id = 'repair-asap-chat-button';
    
    // SVG иконка чата
    chatButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="30px" height="30px">
        <path d="M0 0h24v24H0z" fill="none"/>
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
      </svg>
    `;
    
    chatButton.addEventListener('click', toggleChat);
    const chatWindow = document.createElement('div');
    chatWindow.id = 'repair-asap-chat-window';
    const chatHeader = document.createElement('div');
    chatHeader.id = 'repair-asap-chat-header';
    chatHeader.innerHTML = `<h3>Repair ASAP Support</h3><button id="repair-asap-chat-close">×</button>`;
    const chatMessages = document.createElement('div');
    chatMessages.id = 'repair-asap-chat-messages';
    const welcomeMessage = document.createElement('div');
    welcomeMessage.className = 'chat-message bot-message';
    welcomeMessage.textContent = 'Hello! How can I help you with your repair needs today?';
    chatMessages.appendChild(welcomeMessage);
    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'repair-asap-chat-input-container';
    const chatInput = document.createElement('input');
    chatInput.id = 'repair-asap-chat-input';
    chatInput.type = 'text';
    chatInput.placeholder = 'Type your message...';
    chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    const chatSend = document.createElement('button');
    chatSend.id = 'repair-asap-chat-send';
    chatSend.textContent = 'Send';
    chatSend.addEventListener('click', sendMessage);
    chatInputContainer.appendChild(chatInput);
    chatInputContainer.appendChild(chatSend);
    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(chatMessages);
    chatWindow.appendChild(chatInputContainer);
    chatContainer.appendChild(chatWindow);
    chatContainer.appendChild(chatButton);
    container.appendChild(chatContainer);
    document.getElementById('repair-asap-chat-close').addEventListener('click', toggleChat);
    initThread();
  }

  function toggleChat() {
    const chatWindow = document.getElementById('repair-asap-chat-window');
    state.isOpen = !state.isOpen;
    chatWindow.classList.toggle('open', state.isOpen);
    if (state.isOpen) {
      setTimeout(() => { document.getElementById('repair-asap-chat-input').focus(); }, 300);
    }
  }

  async function initThread() {
    try {
      console.log('Initializing thread...');
      const healthResponse = await fetch(`${config.apiEndpoint}/api/health`);
      if (!healthResponse.ok) throw new Error(`API health check failed: ${healthResponse.status}`);
      
      const response = await fetch(`${config.apiEndpoint}/api/thread`, { method: 'POST' });
      if (!response.ok) throw new Error(`Failed to create thread: ${response.status}`);
      const data = await response.json();
      state.threadId = data.threadId;
      console.log('Thread initialized:', state.threadId);
    } catch (error) {
      console.error('Error initializing thread:', error);
      showError('Failed to initialize chat. Please try again later.');
    }
  }

  async function sendMessage() {
    const inputEl = document.getElementById('repair-asap-chat-input');
    const message = inputEl.value.trim();
    if (!message || state.isLoading || !state.threadId) return;
    inputEl.value = '';
    addMessageToUI('user', message);
    state.isLoading = true;
    showLoadingIndicator();
    try {
      console.log('Sending message:', message);
      const response = await fetch(`${config.apiEndpoint}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: state.threadId, message: message })
      });
      removeLoadingIndicator(); // Убираем индикатор СРАЗУ после ответа сервера
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `Server responded with status ${response.status}` }));
        throw new Error(errorData.error || `Request failed with status ${response.status}`);
      }
      
      const data = await response.json();
      if (data.message) {
        console.log('Received response:', data.message.substring(0, 50) + '...');
        addMessageToUI('bot', data.message);
      } else {
        throw new Error('Invalid response from server (no message)');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      showError(`Failed to get response: ${error.message}. Please try again.`);
    } finally {
      state.isLoading = false;
    }
  }

  function addMessageToUI(sender, text) {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `chat-message ${sender === 'user' ? 'user-message' : 'bot-message'}`;

    let processedHtml = text;
    // 1. Markdown ссылки: [текст](URL)
    const markdownLinkRegex = /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g;
    processedHtml = processedHtml.replace(markdownLinkRegex, (match, linkText, url) => {
      const safeText = linkText.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${safeText}</a>`;
    });
    
    // 2. "Голые" URL (http/https), не являющиеся частью markdown ссылки
    const urlRegex = /(?<!href="|">)(?<!]\()(\b(https?):\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/gi;
    processedHtml = processedHtml.replace(urlRegex, (url) => {
        // Проверка, не является ли URL уже частью тега <a>
        const checkString = processedHtml;
        const urlPos = checkString.indexOf(url);
        const lookbehind = checkString.substring(Math.max(0, urlPos - 10), urlPos);
        const lookahead = checkString.substring(urlPos + url.length, urlPos + url.length + 10);
        if(lookbehind.includes('<a href') || lookahead.includes('</a>')) {
            return url; // Уже ссылка, не трогаем
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    // Используем innerHTML для отображения ссылок
    messageElement.innerHTML = processedHtml;

    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function showLoadingIndicator() {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    if (document.getElementById('loading-indicator')) return;
    const loadingElement = document.createElement('div');
    loadingElement.className = 'loading-indicator';
    loadingElement.id = 'loading-indicator';
    loadingElement.innerHTML = `Thinking <div class="loading-dots"><span></span><span></span><span></span></div>`;
    messagesContainer.appendChild(loadingElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function removeLoadingIndicator() {
    const loadingElement = document.getElementById('loading-indicator');
    if (loadingElement) loadingElement.remove();
  }

  function showError(message) {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    const existingError = messagesContainer.querySelector('.error-message');
    if(existingError) existingError.remove();
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    errorElement.textContent = message;
    messagesContainer.appendChild(errorElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setTimeout(() => { if (errorElement) errorElement.remove(); }, 5000);
  }

  function init() {
    if (!document.getElementById(containerId)) {
        console.warn(`Chatbot container #${containerId} not found. Creating one in body.`);
        const fallbackContainer = document.createElement('div');
        fallbackContainer.id = containerId;
        document.body.appendChild(fallbackContainer);
    }
    injectStyles();
    createChatUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();