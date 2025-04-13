/**
 * Repair ASAP LLC Chatbot Implementation
 * This script creates and manages the chatbot UI and API communication.
 */

(function() {
  // Configuration
  const config = {
    apiEndpoint: 'https://api.asap.repair',
    primaryColor: '#0066CC',
    fontFamily: 'Montserrat, sans-serif',
  };
  
  // Main container ID
  const containerId = 'repair-asap-chatbot';
  
  // Store conversation state
  let state = {
    threadId: null,
    messages: [],
    isOpen: false,
    isLoading: false,
    hasError: false,
  };
  
  // Create and inject CSS
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #repair-asap-chatbot-container {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        font-family: ${config.fontFamily};
      }
      
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
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        transition: all 0.3s ease;
      }
      
      #repair-asap-chat-button:hover {
        transform: scale(1.05);
      }
      
      #repair-asap-chat-button svg {
        width: 30px;
        height: 30px;
      }
      
      #repair-asap-chat-window {
        position: absolute;
        bottom: 70px;
        right: 0;
        width: 350px;
        height: 500px;
        background-color: white;
        border-radius: 10px;
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: all 0.3s ease;
        opacity: 0;
        transform: translateY(20px);
        pointer-events: none;
      }
      
      #repair-asap-chat-window.open {
        opacity: 1;
        transform: translateY(0);
        pointer-events: all;
      }
      
      #repair-asap-chat-header {
        background-color: ${config.primaryColor};
        color: white;
        padding: 15px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      #repair-asap-chat-header h3 {
        margin: 0;
        font-size: 16px;
      }
      
      #repair-asap-chat-close {
        cursor: pointer;
        background: none;
        border: none;
        color: white;
        font-size: 20px;
      }
      
      #repair-asap-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 15px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      
      .chat-message {
        max-width: 80%;
        padding: 10px 15px;
        border-radius: 15px;
        margin-bottom: 5px;
        word-wrap: break-word;
      }
      
      .user-message {
        background-color: #E9F5FF;
        color: #333;
        align-self: flex-end;
        border-bottom-right-radius: 5px;
      }
      
      .bot-message {
        background-color: #F2F2F2;
        color: #333;
        align-self: flex-start;
        border-bottom-left-radius: 5px;
      }
      
      #repair-asap-chat-input-container {
        padding: 15px;
        border-top: 1px solid #eee;
        display: flex;
        gap: 10px;
      }
      
      #repair-asap-chat-input {
        flex: 1;
        padding: 10px 15px;
        border: 1px solid #ddd;
        border-radius: 20px;
        outline: none;
        font-family: ${config.fontFamily};
      }
      
      #repair-asap-chat-input:focus {
        border-color: ${config.primaryColor};
      }
      
      #repair-asap-chat-send {
        background-color: ${config.primaryColor};
        color: white;
        border: none;
        border-radius: 20px;
        padding: 10px 15px;
        cursor: pointer;
        font-family: ${config.fontFamily};
      }
      
      #repair-asap-chat-send:disabled {
        background-color: #ccc;
        cursor: not-allowed;
      }
      
      .loading-indicator {
        display: flex;
        align-items: center;
        padding: 10px 15px;
        color: #666;
        font-style: italic;
      }
      
      .loading-dots {
        display: flex;
        margin-left: 5px;
      }
      
      .loading-dots span {
        width: 6px;
        height: 6px;
        margin: 0 2px;
        background-color: #666;
        border-radius: 50%;
        animation: loading-dots 1.4s infinite ease-in-out both;
      }
      
      .loading-dots span:nth-child(1) {
        animation-delay: -0.32s;
      }
      
      .loading-dots span:nth-child(2) {
        animation-delay: -0.16s;
      }
      
      @keyframes loading-dots {
        0%, 80%, 100% { transform: scale(0); }
        40% { transform: scale(1); }
      }
      
      .error-message {
        color: #e74c3c;
        text-align: center;
        padding: 10px;
        margin: 10px;
        border: 1px solid #e74c3c;
        border-radius: 5px;
        background-color: #fadbd8;
      }
    `;
    document.head.appendChild(style);
  }
  
  // Create chat UI
  function createChatUI() {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const chatContainer = document.createElement('div');
    chatContainer.id = 'repair-asap-chatbot-container';
    
    // Chat button
    const chatButton = document.createElement('div');
    chatButton.id = 'repair-asap-chat-button';
    chatButton.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    `;
    chatButton.addEventListener('click', toggleChat);
    
    // Chat window
    const chatWindow = document.createElement('div');
    chatWindow.id = 'repair-asap-chat-window';
    
    // Chat header
    const chatHeader = document.createElement('div');
    chatHeader.id = 'repair-asap-chat-header';
    chatHeader.innerHTML = `
      <h3>Repair ASAP Support</h3>
      <button id="repair-asap-chat-close">×</button>
    `;
    
    // Chat messages container
    const chatMessages = document.createElement('div');
    chatMessages.id = 'repair-asap-chat-messages';
    
    // Add welcome message
    const welcomeMessage = document.createElement('div');
    welcomeMessage.className = 'chat-message bot-message';
    welcomeMessage.textContent = 'Hello! How can I help you with your repair needs today?';
    chatMessages.appendChild(welcomeMessage);
    
    // Chat input container
    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'repair-asap-chat-input-container';
    
    const chatInput = document.createElement('input');
    chatInput.id = 'repair-asap-chat-input';
    chatInput.type = 'text';
    chatInput.placeholder = 'Type your message...';
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
    
    const chatSend = document.createElement('button');
    chatSend.id = 'repair-asap-chat-send';
    chatSend.textContent = 'Send';
    chatSend.addEventListener('click', sendMessage);
    
    // Assemble UI
    chatInputContainer.appendChild(chatInput);
    chatInputContainer.appendChild(chatSend);
    chatWindow.appendChild(chatHeader);
    chatWindow.appendChild(chatMessages);
    chatWindow.appendChild(chatInputContainer);
    chatContainer.appendChild(chatWindow);
    chatContainer.appendChild(chatButton);
    container.appendChild(chatContainer);
    
    // Add event listeners
    document.getElementById('repair-asap-chat-close').addEventListener('click', toggleChat);
    
    // Initialize thread
    initThread();
  }
  
  // Toggle chat window
  function toggleChat() {
    const chatWindow = document.getElementById('repair-asap-chat-window');
    state.isOpen = !state.isOpen;
    
    if (state.isOpen) {
      chatWindow.classList.add('open');
      setTimeout(() => {
        document.getElementById('repair-asap-chat-input').focus();
      }, 300);
    } else {
      chatWindow.classList.remove('open');
    }
  }
  
  // Initialize OpenAI thread
  async function initThread() {
    try {
      // Check API health
      const healthResponse = await fetch(`${config.apiEndpoint}/api/health`);
      if (!healthResponse.ok) throw new Error('API is not available');
      
      // Fetch assistant ID from server
      const configResponse = await fetch(`${config.apiEndpoint}/api/config`);
      if (!configResponse.ok) throw new Error('Failed to fetch config');
      const configData = await configResponse.json();
      config.assistantId = configData.assistantId;

      // Create thread
      const response = await fetch(`${config.apiEndpoint}/api/thread`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      if (!response.ok) throw new Error('Failed to create thread');
      
      const data = await response.json();
      state.threadId = data.threadId;
    } catch (error) {
      console.error('Error initializing thread:', error);
      showError('Failed to initialize chat. Please try again later.');
    }
  }
  
  // Send message to OpenAI API
  async function sendMessage() {
    const inputEl = document.getElementById('repair-asap-chat-input');
    const message = inputEl.value.trim();
    
    if (!message || state.isLoading || !state.threadId) return;
    
    // Clear input
    inputEl.value = '';
    
    // Add user message to UI
    addMessageToUI('user', message);
    
    // Set loading state
    state.isLoading = true;
    showLoadingIndicator();
    
    try {
      // Send message to API
      const response = await fetch(`${config.apiEndpoint}/api/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          threadId: state.threadId,
          message: message
        })
      });
      
      if (!response.ok) throw new Error('Failed to send message');
      
      const data = await response.json();
      
      // Remove loading indicator
      removeLoadingIndicator();
      
      // Add bot response to UI
      if (data.message) {
        addMessageToUI('bot', data.message);
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      console.error('Error sending message:', error);
      removeLoadingIndicator();
      showError('Failed to get a response. Please try again.');
    } finally {
      state.isLoading = false;
    }
  }
  
  // Add message to UI
  function addMessageToUI(sender, text) {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `chat-message ${sender === 'user' ? 'user-message' : 'bot-message'}`;
    messageElement.textContent = text;
    
    messagesContainer.appendChild(messageElement);
    
    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    // Add to state
    state.messages.push({ sender, text });
  }
  
  // Show loading indicator
  function showLoadingIndicator() {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    const loadingElement = document.createElement('div');
    loadingElement.className = 'loading-indicator';
    loadingElement.id = 'loading-indicator';
    loadingElement.innerHTML = `
      Thinking
      <div class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
    
    messagesContainer.appendChild(loadingElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  
  // Remove loading indicator
  function removeLoadingIndicator() {
    const loadingElement = document.getElementById('loading-indicator');
    if (loadingElement) {
      loadingElement.remove();
    }
  }
  
  // Show error message
  function showError(message) {
    const messagesContainer = document.getElementById('repair-asap-chat-messages');
    const errorElement = document.createElement('div');
    errorElement.className = 'error-message';
    errorElement.textContent = message;
    
    messagesContainer.appendChild(errorElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    setTimeout(() => {
      errorElement.remove();
    }, 5000);
  }
  
  // Initialize when DOM is ready
  function init() {
    injectStyles();
    createChatUI();
  }
  
  // Check if document is already loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
