// lib/telegram.js — Shared Telegram multi-group routing
// chatType: 'leads' | 'activity' | 'receipts'

function getTelegramChatId(chatType) {
    const map = {
        leads: process.env.TELEGRAM_CHAT_LEADS,
        activity: process.env.TELEGRAM_CHAT_ACTIVITY,
        receipts: process.env.TELEGRAM_CHAT_RECEIPTS,
    };
    return map[chatType] || process.env.TELEGRAM_ADMIN_ID;
}

async function sendToTelegram(text, chatType = 'leads') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getTelegramChatId(chatType);
    if (!token || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
        });
    } catch (error) {
        console.error('Telegram Error:', error);
    }
}

async function sendPhotoToTelegram(base64Data, caption = '', chatType = 'leads') {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = getTelegramChatId(chatType);
    if (!token || !chatId || !base64Data) return;
    try {
        const buffer = Buffer.from(base64Data, 'base64');
        const boundary = '----FormBoundary' + Date.now();
        const parts = [];
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="chat-photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
        const header = parts.join('\r\n');
        const footer = `\r\n--${boundary}--\r\n`;
        const bodyBuffer = Buffer.concat([Buffer.from(header), buffer, Buffer.from(footer)]);
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
            body: bodyBuffer
        });
    } catch (error) {
        console.error('Telegram Photo Error:', error);
    }
}

module.exports = { sendToTelegram, sendPhotoToTelegram, getTelegramChatId };
