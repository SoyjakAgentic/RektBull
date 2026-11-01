/**
 * Block explorer API, Etherscan-style, ported from soyjak-agentic's
 * etherscanApi.js.
 *
 * Etherscan API V2 is tried first, then Blockscout's PRO API, which takes the
 * same module/action calls and has a free plan. Etherscan's free plan does not
 * cover every chain; when it refuses one for plan reasons, or has used its
 * daily allowance, the call goes to Blockscout. Blockscout's getsourcecode
 * reply is rewritten into Etherscan's shape so callers read one format.
 */
const axios = require('axios');
const env = require('../config/env');
const { EVM } = require('./chains');
const { track } = require('./usage');

const EXPLORERS = [
  { name: 'etherscan', url: 'https://api.etherscan.io/v2/api', key: () => env.etherscanApiKey },
  { name: 'blockscout', url: 'https://api.blockscout.com/v2/api', key: () => env.blockscoutApiKey },
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
    const key = ex.key();
    if (!key) { tried.push(`${ex.name}: no key`); continue; }
    try {
      const data = await track(ex.name, async () => (await axios.get(ex.url, { params: { chainid, ...params, apikey: key }, timeout })).data);
      if (refusedForPlan(data)) { tried.push(`${ex.name}: ${data.result || data.message}`); continue; }
      if (ex.name === 'blockscout' && params.module === 'contract' && params.action === 'getsourcecode' && Array.isArray(data?.result)) {
        return { ...data, result: data.result.map(blockscoutSourceRow) };
      }
      return data;
    } catch (err) {
      tried.push(`${ex.name}: ${err.message}`);
    }
  }
  throw new ExplorerError(`no explorer answered for ${chain} (${tried.join('; ')})`);
}

module.exports = { explorerGet, blockscoutSourceRow, refusedForPlan, ExplorerError, UNVERIFIED };
