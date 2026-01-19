(function() {
  // --- Конфигурация ---
  const config = {
    apiEndpoint: 'https://api.asap.repair', // Убедись, что это твой актуальный URL
    primaryColor: '#0066CC',
    fontFamily: 'Montserrat, sans-serif',
    storageKey: 'repair_asap_thread_id' // Ключ для сохранения сессии
  };
  const containerId = 'repair-asap-chatbot';
  // --------------------

  let state = { threadId: null, isOpen: false, isLoading: false };

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #repair-asap-chatbot-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: ${config.fontFamily}; }
      
      /* Кнопка чата */
      #repair-asap-chat-button { width: 60px; height: 60px; border-radius: 50%; background-color: ${config.primaryColor}; color: white; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); transition: all 0.3s ease; }
      #repair-asap-chat-button:hover { transform: scale(1.05); }
      #repair-asap-chat-button svg { width: 30px; height: 30px; }
      
      /* Окно чата */
      #repair-asap-chat-window { position: absolute; bottom: 80px; right: 0; width: 360px; height: 550px; background-color: white; border-radius: 12px; box-shadow: 0 5px 25px rgba(0, 0, 0, 0.15); display: flex; flex-direction: column; overflow: hidden; transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1); opacity: 0; transform: translateY(20px) scale(0.95); pointer-events: none; border: 1px solid #eee; }
      #repair-asap-chat-window.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: all; }
      
      /* Заголовок */
      #repair-asap-chat-header { background-color: ${config.primaryColor}; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
      #repair-asap-chat-close { cursor: pointer; background: none; border: none; color: white; font-size: 24px; line-height: 1; padding: 0; opacity: 0.8; }
      #repair-asap-chat-close:hover { opacity: 1; }
      
      /* Область сообщений */
      #repair-asap-chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; background-color: #f9f9f9; }
      .chat-message { max-width: 85%; padding: 12px 16px; border-radius: 18px; font-size: 14px; line-height: 1.5; word-wrap: break-word; animation: fadeIn 0.3s ease; }
      .user-message { background-color: #E3F2FD; color: #0d47a1; align-self: flex-end; border-bottom-right-radius: 4px; }
      .bot-message { background-color: #FFFFFF; color: #333; align-self: flex-start; border-bottom-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); border: 1px solid #eee; }
      .bot-message a { color: ${config.primaryColor}; text-decoration: none; border-bottom: 1px solid rgba(0,102,204,0.3); }
      .bot-message a:hover { border-bottom-color: ${config.primaryColor}; }
      
      /* Ввод текста */
      #repair-asap-chat-input-container { padding: 15px; background: white; border-top: 1px solid #eee; display: flex; gap: 10px; align-items: center; }
      #repair-asap-chat-input { flex: 1; padding: 12px 15px; border: 1px solid #ddd; border-radius: 25px; outline: none; font-size: 14px; transition: border-color 0.2s; font-family: ${config.fontFamily}; }
      #repair-asap-chat-input:focus { border-color: ${config.primaryColor}; }
      #repair-asap-chat-send { background-color: ${config.primaryColor}; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.2s; }
      #repair-asap-chat-send:hover { background-color: #0055aa; }
      #repair-asap-chat-send svg { width: 18px; height: 18px; fill: white; margin-left: 2px; }
      
      /* Анимации и Индикаторы */
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      .loading-indicator { padding: 10px 15px; color: #888; font-size: 13px; display: flex; align-items: center; font-style: italic; }
      .loading-dots span { width: 5px; height: 5px; margin: 0 2px; background-color: #888; border-radius: 50%; display: inline-block; animation: bounce 1.4s infinite ease-in-out both; }
      .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
      .loading-dots span:nth-child(2) { animation-delay: -0.16s; }
      @keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }
      
      /* Подсветка авто-заполненных полей */
      @keyframes highlight-field { 0% { background-color: white; } 50% { background-color: #e6f7ff; } 100% { background-color: white; } }
      .auto-filled-field { animation: highlight-field 1.5s ease-in-out; border-color: ${config.primaryColor} !important; }

      /* === МОБИЛЬНАЯ АДАПТАЦИЯ === */
      @media (max-width: 480px) {
        #repair-asap-chat-window { width: 100% !important; height: 100% !important; bottom: 0 !important; right: 0 !important; border-radius: 0 !important; transform: translateY(100%); z-index: 10000; }
        #repair-asap-chat-window.open { transform: translateY(0); }
        #repair-asap-chat-button { bottom: 20px; right: 20px; }
        #repair-asap-chatbot-container { bottom: 0; right: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  function createChatUI() {
    const container = document.getElementById(containerId);
    if (!container) return; // Silent fail if container missing
    
    const chatContainer = document.createElement('div');
    chatContainer.id = 'repair-asap-chatbot-container';
    
    // Кнопка
    const chatButton = document.createElement('div');
    chatButton.id = 'repair-asap-chat-button';
    chatButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    chatButton.addEventListener('click', toggleChat);
    
    // Окно
    const chatWindow = document.createElement('div');
    chatWindow.id = 'repair-asap-chat-window';
    
    // Header
    const chatHeader = document.createElement('div');
    chatHeader.id = 'repair-asap-chat-header';
    chatHeader.innerHTML = `<span>Repair ASAP</span><button id="repair-asap-chat-close">×</button>`;
    
    // Messages
    const chatMessages = document.createElement('div');
    chatMessages.id = 'repair-asap-chat-messages';
    
    // Input
    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'repair-asap-chat-input-container';
    const chatInput = document.createElement('input');
    chatInput.id = 'repair-asap-chat-input';
    chatInput.type = 'text';
    chatInput.placeholder = 'Message...';
    chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    
    const chatSend = document.createElement('button');
    chatSend.id = 'repair-asap-chat-send';
    chatSend.innerHTML = `<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
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
    
    // При открытии - фокус на инпут и прокрутка вниз
    if (state.isOpen) {
      setTimeout(() => { 
          document.getElementById('repair-asap-chat-input').focus(); 
          const msgs = document.getElementById('repair-asap-chat-messages');
          msgs.scrollTop = msgs.scrollHeight;
      }, 300);
    }
  }

  async function initThread() {
    // 1. Пытаемся восстановить ID из localStorage
    const storedThreadId = localStorage.getItem(config.storageKey);
    
    if (storedThreadId) {
        state.threadId = storedThreadId;
        console.log('Chat session restored:', state.threadId);
        // Можно добавить сообщение "Welcome back", если история пуста в UI
        if (document.getElementById('repair-asap-chat-messages').children.length === 0) {
             addMessageToUI('bot', 'Hello! I am ready to help you again.');
        }
        return;
    }

    // 2. Если нет - создаем новый
    try {
      const response = await fetch(`${config.apiEndpoint}/api/thread`, { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        state.threadId = data.threadId;
        localStorage.setItem(config.storageKey, state.threadId); // Сохраняем
        addMessageToUI('bot', 'Hello! How can I help you with your repair needs today?');
      }
    } catch (e) { console.error('Init failed', e); }
  }

  async function sendMessage() {
    const inputEl = document.getElementById('repair-asap-chat-input');
    const message = inputEl.value.trim();
    if (!message || state.isLoading || !state.threadId) return;
    
    inputEl.value = '';
    addMessageToUI('user', message);
    state.isLoading = true;
    showLoading();
    
    try {
      const response = await fetch(`${config.apiEndpoint}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: state.threadId, message: message })
      });
      
      removeLoading();
      
      if (!response.ok) throw new Error('Server error');
      
      const data = await response.json();
      
      if (data.message) {
        addMessageToUI('bot', data.message);
        
        // === ЛОГИКА АВТОЗАПОЛНЕНИЯ ФОРМЫ ===
        if (data.action && data.action.type === 'FILL_FORM') {
            triggerWebsiteForm(data.action.payload);
        }
        // ===================================
      }
      
    } catch (error) {
      removeLoading();
      addMessageToUI('bot', 'Sorry, I am having trouble connecting right now.');
      console.error(error);
    } finally {
      state.isLoading = false;
    }
  }

  // --- Функция-магия для сайта ---
  function triggerWebsiteForm(payload) {
    console.log('🤖 Bot is auto-filling the form:', payload);
    
    // Хелпер для заполнения и триггера событий
    const fill = (selector, value) => {
        // Ищем по селектору или атрибуту name
        const el = document.querySelector(selector) || 
                   document.querySelector(`input[name="${selector}"]`) ||
                   document.querySelector(`input[name="${selector.toLowerCase()}"]`); // name="phone"
                   
        if (el && value) {
            el.value = value;
            el.classList.add('auto-filled-field');
            // Важно для Тильды/React/Angular форм:
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            return el; // Возвращаем элемент, чтобы найти родительскую форму
        }
        return null;
    };

    fill('Name', payload.name);
    fill('Email', payload.email);
    const phoneEl = fill('Phone', payload.phone) || fill('Tel', payload.phone);

    // Пытаемся найти кнопку отправки
    if (phoneEl && phoneEl.form) {
        const form = phoneEl.form;
        const btn = form.querySelector('button[type="submit"]') || form.querySelector('.t-submit');
        
        if (btn) {
            // Скроллим к форме плавно
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
            
            // Жмем кнопку через секунду (для эффекта)
            setTimeout(() => {
                console.log('🤖 Bot clicking submit...');
                btn.click();
            }, 1500);
        }
    }
  }

  function addMessageToUI(sender, text) {
    const container = document.getElementById('repair-asap-chat-messages');
    const div = document.createElement('div');
    div.className = `chat-message ${sender === 'user' ? 'user-message' : 'bot-message'}`;
    
    // Markdown links & line breaks
    let html = text
        .replace(/\n/g, '<br>') // Сохраняем переносы строк
        .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
        
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showLoading() {
    const container = document.getElementById('repair-asap-chat-messages');
    const div = document.createElement('div');
    div.id = 'chat-loading';
    div.className = 'loading-indicator';
    div.innerHTML = `Thinking <div class="loading-dots"><span></span><span></span><span></span></div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function removeLoading() {
    const el = document.getElementById('chat-loading');
    if (el) el.remove();
  }

  function init() {
    if (!document.getElementById(containerId)) {
        const c = document.createElement('div');
        c.id = containerId;
        document.body.appendChild(c);
    }
    injectStyles();
    createChatUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();