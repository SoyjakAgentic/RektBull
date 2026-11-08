/**
 * Telegram Bot API calls for Group Guard (the alert channel's sendMessage is
 * in src/alerts/transports.js). Every call is counted by providers/usage.
 * Messages are plain text: nothing from a group is ever parsed as markup.
 */
const axios = require('axios');
const env = require('../config/env');
const { track } = require('./usage');

class TelegramError extends Error {}

async function call(method, params) {
  try {
    const data = await track('telegram', async () => (await axios.post(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, params, { timeout: 10000 })).data);
    if (!data?.ok) throw new TelegramError(data?.description || `${method} failed`);
    return data.result;
  } catch (err) {
    if (err instanceof TelegramError) throw err;
    throw new TelegramError(`Telegram ${method}: ${err.response?.data?.description || err.message}`);
  }
}

module.exports = {
  call,
  TelegramError,
  reply: (chatId, messageId, text) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...(messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {}) }),
  send: (chatId, text) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),
  deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
  admins: chatId => call('getChatAdministrators', { chat_id: chatId }),
  member: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }),
  /** A message with one row of buttons: [{ text, data }] (callback buttons) or [{ text, url }]. */
  buttons: (chatId, text, row) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, reply_markup: { inline_keyboard: [row.map(b => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))] } }),
  edit: (chatId, messageId, text) => call('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true }),
  answer: (callbackId, text) => call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) }),
};
