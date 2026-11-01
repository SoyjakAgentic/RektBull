/**
 * JSON-RPC with fallback: each configured endpoint in turn, then the
 * public one. A node error (the call itself is wrong) is not retried
 * elsewhere; a network error, a rate limit or a 5xx is.
 */
const axios = require('axios');
const { rpcUrls } = require('./chains');
const { track } = require('./usage');

class RpcError extends Error {}

const providerName = url => {
  try { return `rpc:${new URL(url).hostname}`; } catch { return 'rpc'; }
};

async function call(chain, method, params, { timeout = 12000 } = {}) {
  const urls = rpcUrls(chain);
  if (!urls.length) throw new RpcError(`no RPC endpoint for ${chain}`);
  let lastErr;
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
      if (err.fromNode) throw err;
      lastErr = err;
    }
  }
  throw new RpcError(`${method} on ${chain}: every endpoint failed (${lastErr?.message || 'unknown error'})`);
}

const evmRpc = (chain, method, params, opts) => call(chain, method, params, opts);
const solanaRpc = (method, params, opts) => call('solana', method, params, opts);

module.exports = { evmRpc, solanaRpc, RpcError };
