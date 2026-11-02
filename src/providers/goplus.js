/**
 * GoPlus security APIs used by approval cleanup (free, keyless; counted by
 * providers/usage and cached). Token checks call GoPlus from
 * services/tokenRisk.js.
 *
 * - approvalsOf: the approvals GoPlus has indexed for a wallet (ERC-20, and
 *   NFT approvals for all). Partial: GoPlus doesn't index every wallet, so
 *   it's a second source next to the explorer's logs, never the only one.
 * - contractRisk: what GoPlus knows about a contract someone approved.
 * - addressRisk: whether an address is flagged (phishing, theft, sanctions).
 */
const axios = require('axios');
const { EVM } = require('./chains');
const { track } = require('./usage');
const { cached } = require('../lib/cache');

const BASE = 'https://api.gopluslabs.io/api';
const DAY = 24 * 60 * 60;

/** The result of a GoPlus call; code 2 ("partial data obtained") still answers, marked partial. */
async function get(path, params) {
  const data = await track('goplus', async () => (await axios.get(`${BASE}${path}`, { params, timeout: 15000 })).data);
  if (data?.code !== 1 && data?.code !== 2) throw new Error(`GoPlus: ${data?.message || 'no answer'}`);
  const result = data.result;
  if (data.code === 2 && result && typeof result === 'object') Object.defineProperty(result, 'partial', { value: true });
  return result;
}

const flag = v => (v === 1 || v === '1' ? true : v === 0 || v === '0' ? false : null);

/** [{ kind: 'erc20'|'nft_all', token, spender }] GoPlus has seen for owner on chain. */
async function approvalsOf(chain, owner) {
  const id = EVM[chain]?.goplus;
  if (!id) return { not_checked: `GoPlus does not cover ${chain}` };
  return cached(`goplus:approvals:${chain}:${owner}`, 10 * 60, async () => {
    const out = [];
    const [erc20, nft721, nft1155] = await Promise.all([
      get(`/v2/token_approval_security/${id}`, { addresses: owner }),
      get(`/v2/nft721_approval_security/${id}`, { addresses: owner }),
      get(`/v2/nft1155_approval_security/${id}`, { addresses: owner }),
    ]);
    for (const t of erc20 || []) for (const a of t.approved_list || []) out.push({ kind: 'erc20', token: String(t.token_address).toLowerCase(), spender: String(a.approved_contract).toLowerCase() });
    for (const t of [...(nft721 || []), ...(nft1155 || [])]) {
      for (const a of t.approved_list || []) {
        // Only approvals for the whole collection; single-NFT approvals carry a token id.
        if (a.approved_for_all === 1 || a.approved_for_all === '1' || a.approved_token_id === undefined || a.approved_token_id === null) {
          out.push({ kind: 'nft_all', token: String(t.nft_address).toLowerCase(), spender: String(a.approved_contract).toLowerCase() });
        }
      }
    }
    const partial = [erc20, nft721, nft1155].some(r => r?.partial);
    return { source: 'GoPlus', approvals: out, ...(partial ? { partial: 'GoPlus said it has only part of the data for this wallet' } : {}) };
  });
}

/** What GoPlus knows about a contract that holds approvals. */
async function contractRisk(chain, address) {
  const id = EVM[chain]?.goplus;
  if (!id) return { not_checked: `GoPlus does not cover ${chain}` };
  return cached(`goplus:approval_security:${chain}:${address}`, DAY, async () => {
    const r = await get(`/v1/approval_security/${id}`, { contract_addresses: address });
    if (!r || !Object.keys(r).length) return { source: 'GoPlus', known: false };
    const scan = r.contract_scan || {};
    return {
      source: 'GoPlus', known: true,
      name: r.contract_name || null, tag: r.tag || null,
      is_contract: flag(r.is_contract), open_source: flag(r.is_open_source), proxy: flag(r.is_proxy),
      trusted: flag(r.trust_list), doubted: flag(r.doubt_list),
      deployed_at: r.deployed_time ? new Date(Number(r.deployed_time) * 1000).toISOString() : null,
      malicious: (r.malicious_behavior || []).map(String),
      approval_abuse: flag(scan.approval_abuse), privilege_withdraw: flag(scan.privilege_withdraw),
    };
  });
}

const ADDRESS_FLAGS = {
  phishing_activities: 'phishing', stealing_attack: 'theft', cybercrime: 'cybercrime', sanctioned: 'sanctions',
  money_laundering: 'money laundering', financial_crime: 'financial crime', blackmail_activities: 'blackmail',
  fake_token: 'fake tokens', honeypot_related_address: 'honeypots', malicious_mining_activities: 'malicious mining',
  darkweb_transactions: 'darkweb transactions', mixer: 'a mixer',
};

/** Whether GoPlus has flagged an address, and for what. */
async function addressRisk(chain, address) {
  const id = EVM[chain]?.goplus;
  if (!id) return { not_checked: `GoPlus does not cover ${chain}` };
  return cached(`goplus:address_security:${chain}:${address}`, DAY, async () => {
    const r = await get(`/v1/address_security/${address}`, { chain_id: id });
    const flags = Object.entries(ADDRESS_FLAGS).filter(([k]) => flag(r?.[k]) === true).map(([, label]) => label);
    return { source: r?.data_source ? `GoPlus (data from ${r.data_source})` : 'GoPlus', flags };
  });
}

/** Whether GoPlus lists a website as phishing. Keyed by the site's origin, cached an hour. */
async function phishingSite(origin) {
  return cached(`goplus:phishing_site:${origin}`, 60 * 60, async () => {
    const r = await get('/v1/phishing_site', { url: origin });
    return { source: 'GoPlus phishing site list', phishing: flag(r?.phishing_site) === true };
  });
}

module.exports = { approvalsOf, contractRisk, addressRisk, phishingSite, ADDRESS_FLAGS };
