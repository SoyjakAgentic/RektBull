/**
 * Names for function selectors we don't decode ourselves, from the openchain
 * signature database (free, keyless). Used only to label a call ("this calls
 * multicall(...)"); a name says what a function is called, not what it does,
 * so no risk is ever judged from it. Cached a week.
 */
const axios = require('axios');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

async function functionName(selector) {
  const sel = String(selector || '').toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(sel)) return null;
  return cached(`sig:${sel}`, 7 * 24 * 60 * 60, async () => {
    const data = await track('openchain', async () => (await axios.get('https://api.openchain.xyz/signature-database/v1/lookup', { params: { function: sel, filter: true }, timeout: 5000 })).data);
    const hits = data?.result?.function?.[sel] || [];
    return hits[0]?.name || '';
  }).then(n => n || null).catch(() => null);
}

module.exports = { functionName };
