/**
 * JSON-RPC with fallback: each configured endpoint in turn, then the
 * public one. A node error (the call itself is wrong) is not retried
 * elsewhere; a network error, a rate limit or a 5xx is. Event logs
 * (evmLogs) go to endpoints that answer them, and a node's refusal of a
 * log query for its size or rate ("limit exceeded") is tried elsewhere too.
 */
const axios = require('axios');
const { rpcUrls, logsRpcUrls, topicLogsRpcUrls } = require('./chains');
const { track } = require('./usage');

class RpcError extends Error {}

const providerName = url => {
  try { return `rpc:${new URL(url).hostname}`; } catch { return 'rpc'; }
};

// A node refusing a log query for its size or its rate: another endpoint may answer it.
const REFUSED_FOR_SIZE = /limit|exceed|too many|range|rate/i;

async function call(chain, method, params, { timeout = 12000, urls = rpcUrls(chain), retryRefusals = false } = {}) {
  if (!urls.length) throw new RpcError(`no RPC endpoint for ${chain}`);
  let lastErr;
  let transient = false; // a network error, a timeout, a rate limit or a 5xx: worth asking again shortly
  for (const url of urls) {
    try {
      const data = await track(providerName(url), async () => {
        const { data } = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout });
        return data;
      });
      if (data?.error) {
        // Keep the revert data, so callers can decode a contract's custom error.
        const revert = typeof data.error.data === 'string' ? data.error.data : data.error.data?.data;
        throw Object.assign(new RpcError(data.error.message || `${method} failed`), { fromNode: true, data: revert || undefined });
      }
      return data.result;
    } catch (err) {
      if (err.fromNode && !(retryRefusals && REFUSED_FOR_SIZE.test(err.message))) throw err;
      lastErr = err;
      const status = err.response?.status;
      if (!err.isProviderLimit && (!status || status === 429 || status >= 500)) transient = true;
    }
  }
  throw Object.assign(new RpcError(`${method} on ${chain}: every endpoint failed (${lastErr?.message || 'unknown error'})`), { transient });
}

const evmRpc = (chain, method, params, opts) => call(chain, method, params, opts);
/** eth_getLogs for a filter, from endpoints that answer log queries. */
const evmLogs = (chain, filter, opts = {}) => call(chain, 'eth_getLogs', [filter], { ...opts, urls: logsRpcUrls(chain), retryRefusals: true });
// Logs filtered by topics alone (no contract address): only some keyless endpoints answer them.
const evmTopicLogs = (chain, filter, opts = {}) => call(chain, 'eth_getLogs', [filter], { ...opts, urls: topicLogsRpcUrls(chain), retryRefusals: true });
const solanaRpc = (method, params, opts) => call('solana', method, params, opts);

module.exports = { evmRpc, evmLogs, evmTopicLogs, solanaRpc, RpcError };
