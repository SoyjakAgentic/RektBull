/**
 * RektBull as a remote MCP server, at POST /mcp (Streamable HTTP, stateless).
 *
 * Each request is one JSON-RPC message, answered with JSON: no sessions, no
 * server-sent events, no server-to-client requests, so it runs behind any
 * load balancer. Methods: initialize, ping, tools/list, tools/call; the
 * client's notifications are accepted (202). GET and DELETE answer 405, as
 * the transport allows when a server offers no stream or session.
 *
 * Authorization is optional: a RektBull bearer token (from signing in with a
 * wallet) raises the free allowances, as on the website. No cookies are
 * used, so a browser on another site can't act as a signed-in user.
 */
const express = require('express');
const logger = require('../config/logger');
const { takeFree } = require('../payments/freeLimits');
const tools = require('./tools');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER = { name: 'rektbull', title: 'RektBull', version: '1.0.0', websiteUrl: 'https://rektbull.com' };
const INSTRUCTIONS = 'RektBull checks crypto before you act: wallets, tokens, approvals, dapps, stablecoins, hacks and DAO votes. Every fact names its source; a check that could not run says why. Tools are read-only and free within daily allowances; RektBull never holds funds or keys and nothing here signs or sends a transaction. Nothing is financial advice: report findings with their sources, and never present a token, dapp or campaign as safe.';

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });

/** A tool's answer: the result as structured content and as text, or an error the model can read. */
const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
const toolError = message => ({ content: [{ type: 'text', text: message }], isError: true });

async function callTool(params, req) {
  const tool = tools.TOOLS[params?.name];
  if (!tool) return { rpc: [-32602, `Unknown tool: ${params?.name}`] };
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  const input = tool.parse(args);
  if (input?.error) return toolError(`Input refused: ${input.error}`);
  if (tool.limit) {
    const { ok, limit, signedIn } = await takeFree(req, tool.limit);
    if (!ok) return toolError(`Daily limit reached: ${limit} a day${signedIn ? '' : ' per IP address without signing in (a RektBull bearer token from signing in with a wallet raises it)'}. Try again tomorrow.`);
  }
  try {
    return toolResult(await tool.run(input, { accountId: req.account?.id || null }));
  } catch (err) {
    if (err.status && err.status < 500) return toolError(err.message);
    logger.warn('mcp: tool failed', { tool: params.name, error: err.message });
    return toolError(`${params.name} couldn't run just now (${err.status === 503 ? err.message : 'a data source didn\'t answer'}). Try again shortly.`);
  }
}

async function handle(msg, req) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return result(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return result(id, {});
    case 'tools/list': return result(id, { tools: tools.list() });
    case 'tools/call': {
      const r = await callTool(params, req);
      return r.rpc ? rpcError(id, ...r.rpc) : result(id, r);
    }
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const router = express.Router();

router.post('/mcp', async (req, res) => {
  const version = req.get('mcp-protocol-version');
  if (version && !VERSIONS.includes(version)) return res.status(400).json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}; this server speaks ${VERSIONS.join(', ')}`));
  const msg = req.body;
  if (Array.isArray(msg)) return res.status(400).json(rpcError(null, -32600, 'Send one JSON-RPC message per request'));
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return res.status(400).json(rpcError(null, -32600, 'Not a JSON-RPC 2.0 message'));
  if (msg.method === undefined) return res.status(202).end(); // a response to us; we never send requests
  if (msg.id === undefined || msg.id === null) return res.status(202).end(); // a notification (e.g. notifications/initialized)
  if (typeof msg.method !== 'string') return res.status(400).json(rpcError(msg.id, -32600, 'method must be a string'));
  res.json(await handle(msg, req));
});
router.all('/mcp', (_req, res) => res.set('allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed: this server answers POST only (no stream, no session).')));

module.exports = { router, handle, VERSIONS, SERVER, INSTRUCTIONS };
