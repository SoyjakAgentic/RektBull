/**
 * The three ways an alert leaves RektBull. Each send() resolves when the
 * provider accepted the message, or throws an error with `permanent: true`
 * when the channel can never work again (bot blocked, subscription gone), so
 * the channel is switched off instead of retried. Calls are counted by
 * providers/usage like every other external call.
 */
const axios = require('axios');
const env = require('../config/env');
const { track } = require('../providers/usage');

const permanent = (message, err) => Object.assign(new Error(message), { permanent: true, cause: err });

const telegram = {
  enabled: () => !!(env.telegramBotToken && env.telegramBotUsername),
  /** A message with a link button. Plain text: nothing in an alert is parsed as markup. */
  async send(chatId, m) {
    try {
      await track('telegram', async () => (await axios.post(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
        chat_id: chatId, text: m.text, disable_web_page_preview: true,
        ...(m.url && /^https:\/\//.test(m.url) ? { reply_markup: { inline_keyboard: [[{ text: m.action, url: m.url }]] } } : {}),
      }, { timeout: 10000 })).data);
    } catch (err) {
      const code = err.response?.status;
      const why = err.response?.data?.description || '';
      // 403: the user blocked the bot. A 400 is permanent only when the chat is gone, not when our message was wrong.
      if (code === 403 || (code === 400 && /chat not found|user is deactivated/i.test(why))) throw permanent(`Telegram: ${why || code}`, err);
      throw new Error(`Telegram: ${err.response?.data?.description || err.message}`);
    }
  },
};

const email = {
  enabled: () => !!env.resendApiKey,
  /** Sent through Resend's HTTP API; another provider is a change to this function only. */
  async send({ to, subject, text, html, unsubscribeUrl }) {
    try {
      await track('resend', async () => (await axios.post('https://api.resend.com/emails', {
        from: env.emailFrom, to: [to], subject, text, html,
        ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
      }, { headers: { authorization: `Bearer ${env.resendApiKey}` }, timeout: 10000 })).data);
    } catch (err) {
      const code = err.response?.status;
      if (code === 422) throw permanent(`email: ${err.response?.data?.message || 'rejected'}`, err);
      throw new Error(`email: ${err.response?.data?.message || err.message}`);
    }
  },
};

const push = {
  enabled: () => !!(env.vapidPublicKey && env.vapidPrivateKey),
  /** A browser notification (Web Push, encrypted to the browser's keys). */
  async send(subscription, payload) {
    const webpush = require('web-push');
    try {
      await track('webpush', () => webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject: env.vapidSubject, publicKey: env.vapidPublicKey, privateKey: env.vapidPrivateKey }, TTL: 24 * 60 * 60, timeout: 10000,
      }));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) throw permanent('push: the browser unsubscribed', err);
      throw new Error(`push: ${err.statusCode || ''} ${err.body || err.message}`.trim());
    }
  },
};

module.exports = { telegram, email, push };
