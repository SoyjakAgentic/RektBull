/**
 * IndexNow: tells Bing (which also feeds ChatGPT's and Copilot's search) and
 * the other engines that use it that a page changed, so a new digest is read
 * within minutes, not days. Only when INDEXNOW_KEY is set; the key is public
 * by design (it's served at /<key>.txt to prove the site is ours).
 */
const axios = require('axios');
const env = require('../config/env');
const logger = require('../config/logger');
const { track } = require('../providers/usage');

const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
const key = () => (KEY_RE.test(env.indexNowKey || '') ? env.indexNowKey : null);

/** Pings the changed paths (e.g. ['/research/2026-10-26']). Never throws: indexing is a nicety. */
async function ping(paths) {
  const k = key();
  if (!k || !env.publicUrl.startsWith('https://')) return { sent: false, reason: k ? 'PUBLIC_URL is not https' : 'INDEXNOW_KEY is not set' };
  const body = { host: new URL(env.publicUrl).host, key: k, keyLocation: `${env.publicUrl}/${k}.txt`, urlList: paths.map(p => `${env.publicUrl}${p}`) };
  try {
    await track('indexnow', () => axios.post('https://api.indexnow.org/indexnow', body, { timeout: 10000 }));
    return { sent: true, urls: body.urlList };
  } catch (err) {
    logger.warn('indexnow: ping failed', { error: err.message });
    return { sent: false, reason: err.message };
  }
}

module.exports = { ping, key };
