(function() {
  console.log('Chat Widget v2 loaded'); // Проверка версии в консоли

  // --- КОНФИГУРАЦИЯ ---
  const config = {
    apiEndpoint: 'https://repair-asap-proxy.vercel.app', 
    primaryColor: '#0066CC',
    fontFamily: 'Montserrat, sans-serif',
    storageKey: 'repair_asap_thread_id'
  };
  const containerId = 'repair-asap-chatbot';
  // --------------------

  let state = { threadId: null, isOpen: false, isLoading: false };

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #repair-asap-chatbot-container { 
          position: fixed; 
          bottom: 20px; 
          right: 20px; 
          z-index: 999999;
          font-family: ${config.fontFamily}; 
      }
      
      /* Кнопка чата */
      #repair-asap-chat-button { 
          width: 60px; 
          height: 60px; 
          border-radius: 50%; 
          background-color: ${config.primaryColor}; 
          color: white; 
          display: flex; 
          align-items: center; 
          justify-content: center; 
          cursor: pointer; 
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); 
          transition: transform 0.3s ease, opacity 0.3s ease; 
      }
      #repair-asap-chat-button:hover { transform: scale(1.05); }
      #repair-asap-chat-button svg { width: 30px; height: 30px; }
      
      /* Окно чата (Десктоп) */
      #repair-asap-chat-window { 
          position: absolute; 
          bottom: 80px; 
          right: 0; 
          width: 360px; 
          height: 550px; 
          background-color: white; 
          border-radius: 12px; 
          box-shadow: 0 5px 25px rgba(0, 0, 0, 0.2); 
          display: flex; 
          flex-direction: column; 
          overflow: hidden; 
          opacity: 0; 
          transform: translateY(20px) scale(0.95); 
          pointer-events: none; 
          border: 1px solid #eee;
          visibility: hidden;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      }
      
      /* Состояние "Открыто" (Десктоп) */
      #repair-asap-chat-window.open { 
          opacity: 1; 
          transform: translateY(0) scale(1); 
          pointer-events: all; 
          visibility: visible;
      }
      
      /* --- МОБИЛЬНАЯ АДАПТАЦИЯ (ЖЕСТКАЯ) --- */
      @media (max-width: 600px) {
        /* Контейнер на весь экран */
        #repair-asap-chatbot-container.mobile-active {
            bottom: 0 !important;
            right: 0 !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            height: 100% !important;
            height: 100dvh !important; /* Для Safari */
        }

        /* Кнопка исчезает при открытии */
        #repair-asap-chatbot-container.mobile-active #repair-asap-chat-button {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        /* Окно чата на весь экран */
        #repair-asap-chat-window {
            width: 100% !important;
            height: 100% !important;
            height: 100dvh !important;
            max-height: none !important;
            bottom: 0 !important;
            right: 0 !important;
            left: 0 !important;
            top: 0 !important;
            border-radius: 0 !important;
            position: fixed !important;
            transform: none !important; /* Отключаем анимацию сдвига */
            transition: opacity 0.2s ease !important; /* Только прозрачность */
        }

        /* Открытое состояние на мобильном */
        #repair-asap-chat-window.open {
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: all !important;
            display: flex !important;
        }
        
        #repair-asap-chat-header {
            padding: 15px !important;
            height: 60px;
        }
        
        #repair-asap-chat-messages {
            font-size: 16px !important; /* Читаемый текст */
        }
        
        #repair-asap-chat-input {
            font-size: 16px !important; /* Чтобы не зумил */
        }
      }

      /* Общие стили содержимого */
      #repair-asap-chat-header { background-color: ${config.primaryColor}; color: white; padding: 15px 20px; display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
      #repair-asap-chat-close { cursor: pointer; background: none; border: none; color: white; font-size: 24px; line-height: 1; padding: 0; opacity: 0.8; }
      
      #repair-asap-chat-messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; background-color: #f9f9f9; }
      .chat-message { max-width: 85%; padding: 12px 16px; border-radius: 18px; font-size: 14px; line-height: 1.5; word-wrap: break-word; animation: fadeIn 0.3s ease; }
      .user-message { background-color: #E3F2FD; color: #0d47a1; align-self: flex-end; border-bottom-right-radius: 4px; }
      .bot-message { background-color: #FFFFFF; color: #333; align-self: flex-start; border-bottom-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); border: 1px solid #eee; }
      .bot-message a { color: ${config.primaryColor}; text-decoration: none; border-bottom: 1px solid rgba(0,102,204,0.3); }
      
      #repair-asap-chat-input-container { padding: 15px; background: white; border-top: 1px solid #eee; display: flex; gap: 10px; align-items: center; }
      #repair-asap-chat-input { flex: 1; padding: 12px 15px; border: 1px solid #ddd; border-radius: 25px; outline: none; font-size: 16px; transition: border-color 0.2s; font-family: ${config.fontFamily}; }
      #repair-asap-chat-input:focus { border-color: ${config.primaryColor}; }
      #repair-asap-chat-send { background-color: ${config.primaryColor}; color: white; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      #repair-asap-chat-send svg { width: 18px; height: 18px; fill: white; margin-left: 2px; }
      
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      .loading-indicator { padding: 10px 15px; color: #888; font-size: 13px; display: flex; align-items: center; font-style: italic; }
      .auto-filled-field { animation: highlight-field 1.5s ease-in-out; border-color: ${config.primaryColor} !important; }
      @keyframes highlight-field { 0% { background-color: white; } 50% { background-color: #e6f7ff; } 100% { background-color: white; } }
    `;
    document.head.appendChild(style);
  }

  function createChatUI() {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const chatContainer = document.createElement('div');
    chatContainer.id = 'repair-asap-chatbot-container';
    
    const chatButton = document.createElement('div');
    chatButton.id = 'repair-asap-chat-button';
    chatButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>`;
    chatButton.addEventListener('click', toggleChat);
    
    const chatWindow = document.createElement('div');
    chatWindow.id = 'repair-asap-chat-window';
    
    const chatHeader = document.createElement('div');
    chatHeader.id = 'repair-asap-chat-header';
    chatHeader.innerHTML = `<span>Repair ASAP</span><button id="repair-asap-chat-close">×</button>`;
    
    const chatMessages = document.createElement('div');
    chatMessages.id = 'repair-asap-chat-messages';
    
    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'repair-asap-chat-input-container';
    const chatInput = document.createElement('input');
    chatInput.id = 'repair-asap-chat-input';
    chatInput.type = 'text';
    chatInput.placeholder = 'Message...';
    chatInput.setAttribute('enterkeyhint', 'send');
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
    const container = document.getElementById('repair-asap-chatbot-container');
    
    state.isOpen = !state.isOpen;
    
    if (state.isOpen) {
        // Открытие
        chatWindow.classList.add('open');
        container.classList.add('mobile-active'); // Новый класс для блокировки позиционирования
        
        // Скролл вниз
        setTimeout(() => { 
            const msgs = document.getElementById('repair-asap-chat-messages');
            msgs.scrollTop = msgs.scrollHeight;
        }, 100);
    } else {
        // Закрытие
        chatWindow.classList.remove('open');
        // Задержка удаления класса, чтобы не дергалось
        setTimeout(() => {
            if (!state.isOpen) container.classList.remove('mobile-active');
        }, 300);
    }
  }

  async function initThread() {
    const storedThreadId = localStorage.getItem(config.storageKey);
    if (storedThreadId) {
        state.threadId = storedThreadId;
        if (document.getElementById('repair-asap-chat-messages').children.length === 0) {
             addMessageToUI('bot', 'Hello! I am ready to help you again.');
        }
        return;
    }
    try {
      const response = await fetch(`${config.apiEndpoint}/api/thread`, { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        state.threadId = data.threadId;
        localStorage.setItem(config.storageKey, state.threadId);
        addMessageToUI('bot', 'Hello! How can I help you with your repair needs today?');
      }
    } catch (e) { console.error('Init failed', e); }
  }

  async function sendMessage() {
    const inputEl = document.getElementById('repair-asap-chat-input');
    const message = inputEl.value.trim();
    if (!message || state.isLoading || !state.threadId) return;
    
    inputEl.value = '';
    // inputEl.blur(); // Убрал blur, чтобы клавиатура не прыгала лишний раз
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
        if (data.action && data.action.type === 'FILL_FORM') {
            triggerWebsiteForm(data.action.payload);
        }
      }
    } catch (error) {
      removeLoading();
      addMessageToUI('bot', 'Sorry, I am having trouble connecting right now.');
    } finally {
      state.isLoading = false;
    }
  }

  function triggerWebsiteForm(payload) {
    const fill = (selector, value) => {
        const el = document.querySelector(selector) || document.querySelector(`input[name="${selector}"]`) || document.querySelector(`input[name="${selector.toLowerCase()}"]`);
        if (el && value) {
            el.value = value;
            el.classList.add('auto-filled-field');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return el;
        }
        return null;
    };
    fill('Name', payload.name);
    fill('Email', payload.email);
    const phoneEl = fill('Phone', payload.phone) || fill('Tel', payload.phone);
    if (phoneEl && phoneEl.form) {
        phoneEl.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function addMessageToUI(sender, text) {
    const container = document.getElementById('repair-asap-chat-messages');
    const div = document.createElement('div');
    div.className = `chat-message ${sender === 'user' ? 'user-message' : 'bot-message'}`;
    let html = text.replace(/\n/g, '<br>').replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function showLoading() {
    const container = document.getElementById('repair-asap-chat-messages');
    const div = document.createElement('div');
    div.id = 'chat-loading';
    div.className = 'loading-indicator';
    div.innerHTML = `Thinking...`;
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