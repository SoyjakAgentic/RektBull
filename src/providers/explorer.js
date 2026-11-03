/**
 * Block explorer API, Etherscan-style, ported from soyjak-agentic's
 * etherscanApi.js.
 *
 * Etherscan API V2 is tried first, then Blockscout's PRO API, which takes the
 * same module/action calls and has a free plan, then the chain's public
 * Blockscout explorer with no key (rate-limited; the last resort). Etherscan's free plan does not
 * cover every chain; when it refuses one for plan reasons, or has used its
 * daily allowance, the call goes to Blockscout. Blockscout's getsourcecode
 * reply is rewritten into Etherscan's shape so callers read one format.
 */
const axios = require('axios');
const env = require('../config/env');
const { EVM } = require('./chains');
const { track } = require('./usage');

const EXPLORERS = [
  { name: 'etherscan', url: () => 'https://api.etherscan.io/v2/api', key: () => env.etherscanApiKey },
  { name: 'blockscout', url: () => 'https://api.blockscout.com/v2/api', key: () => env.blockscoutApiKey },
  { name: 'blockscout-public', url: chain => (EVM[chain]?.blockscout ? `https://${EVM[chain].blockscout}/api` : null), keyless: true },
];

const UNVERIFIED = 'Contract source code not verified';

class ExplorerError extends Error {}

/** A reply that means "this explorer won't serve this", not "no data". */
function refusedForPlan(data) {
  const text = `${data?.message || ''} ${typeof data?.result === 'string' ? data.result : ''}`;
  return data?.status === '0' && /plan|upgrade|not supported|free api|api pro|rate limit|chain/i.test(text) && !/no records|no transactions/i.test(text);
}

function blockscoutSourceRow(row = {}) {
  const verified = typeof row.ABI === 'string' && row.ABI !== UNVERIFIED;
  let source = row.SourceCode || '';
  if (verified && Array.isArray(row.AdditionalSources) && row.AdditionalSources.length) {
    const files = { [row.FileName || `${row.ContractName || 'Contract'}.sol`]: source };
    for (const f of row.AdditionalSources) files[f.Filename] = f.SourceCode || '';
    source = JSON.stringify(files);
  }
  return {
    ...row,
    ABI: verified ? row.ABI : UNVERIFIED,
    SourceCode: verified ? source : '',
    ContractName: row.ContractName || '',
    Proxy: row.IsProxy === 'true' || row.Proxy === '1' ? '1' : '0',
    Implementation: row.ImplementationAddress || row.Implementation || '',
  };
}

/** GET the explorer API on a chain; returns { status, message, result } in Etherscan's shape. */
async function explorerGet(chain, params, { timeout = 10000 } = {}) {
  const chainid = EVM[chain]?.chainId;
  if (!chainid) throw new ExplorerError(`no explorer covers ${chain}`);
  const tried = [];
  for (const ex of EXPLORERS) {
    const url = ex.url(chain);
    if (!url) continue;
    const key = ex.keyless ? null : ex.key();
    if (!ex.keyless && !key) { tried.push(`${ex.name}: no key`); continue; }
    try {
      const data = await track(ex.name, async () => (await axios.get(url, { params: { chainid, ...params, ...(key ? { apikey: key } : {}) }, timeout })).data);
      if (refusedForPlan(data)) { tried.push(`${ex.name}: ${data.result || data.message}`); continue; }
      if (ex.name.startsWith('blockscout') && params.module === 'contract' && params.action === 'getsourcecode' && Array.isArray(data?.result)) {
        return { ...data, result: data.result.map(blockscoutSourceRow) };
      }
      return data;
    } catch (err) {
      tried.push(`${ex.name}: ${err.message}`);
    }
  }
  throw new ExplorerError(`no explorer answered for ${chain} (${tried.join('; ')})`);
}

const LOGS_PER_PAGE = 1000; // both Etherscan and Blockscout return at most this many
const blockOf = l => Number(l.blockNumber);

/**
 * Every log matching { address?, topic0?, topic1? } from fromBlock (default 0), paged by
 * block range (works the same on every explorer). Returns { logs, complete }:
 * complete is false when maxPages ran out first (the oldest logs are read).
 */
async function explorerLogs(chain, { address, topic0, topic1 }, { maxPages = 5, fromBlock = 0 } = {}) {
  const logs = [];
  const seen = new Set();
  let from = Number(fromBlock) || 0;
  for (let page = 0; page < maxPages; page++) {
    const params = { module: 'logs', action: 'getLogs', fromBlock: from, toBlock: 'latest' };
    if (address) params.address = address;
    if (topic0) params.topic0 = topic0;
    if (topic1) params.topic1 = topic1;
    if (topic0 && topic1) params.topic0_1_opr = 'and';
    const data = await module.exports.explorerGet(chain, params);
    if (!Array.isArray(data?.result)) {
      if (/no records|no logs/i.test(`${data?.message} ${data?.result}`)) return { logs, complete: true };
      throw new ExplorerError(`logs on ${chain}: ${data?.result || data?.message || 'no answer'}`);
    }
    for (const l of data.result) {
      const id = `${l.transactionHash}:${Number(l.logIndex)}`;
      if (!seen.has(id)) { seen.add(id); logs.push(l); }
    }
    if (data.result.length < LOGS_PER_PAGE) return { logs, complete: true };
    const last = blockOf(data.result[data.result.length - 1]);
    from = last > from ? last : from + 1; // the last block again: it may hold more
  }
  return { logs, complete: false };
}

/** The block at or just before a unix time, from the explorer (cached an hour). */
async function blockAt(chain, unixSeconds) {
  const t = Math.floor(unixSeconds / 3600) * 3600; // to the hour, so the cache is shared
  return require('../lib/cache').cached(`explorer:blockat:${chain}:${t}`, 3600, async () => {
    const data = await module.exports.explorerGet(chain, { module: 'block', action: 'getblocknobytime', timestamp: t, closest: 'before' });
    const n = Number(typeof data?.result === 'object' ? data.result?.blockNumber : data?.result);
    if (!Number.isFinite(n) || n <= 0) throw new ExplorerError(`block at ${t} on ${chain}: ${data?.message || 'no answer'}`);
    return n;
  });
}

module.exports = { explorerGet, explorerLogs, blockAt, blockscoutSourceRow, refusedForPlan, ExplorerError, UNVERIFIED };
