/* Developers: the MCP server (its tools listed by asking the server itself), x402 prices, and the API reference. */
(function () {
  'use strict';
  const { el, say, api, toast } = window.RB;
  const $ = id => document.getElementById(id);
  const origin = location.origin;
  const mcpUrl = `${origin}/mcp`;

  $('mcp-url').textContent = mcpUrl;
  $('x-url').textContent = origin;
  $('mcp-cc').textContent = `claude mcp add --transport http rektbull ${mcpUrl}`;
  $('mcp-json').textContent = JSON.stringify({ mcpServers: { rektbull: { url: mcpUrl } } }, null, 2);
  $('mcp-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(mcpUrl); toast('Copied'); } catch { toast('Select the address and copy it'); }
  });

  const perDay = l => (l ? `${l.anonymous} (${l.account} signed in)` : 'Cached, no daily cap');

  /** Asks the MCP server for its tools, as an agent would. */
  async function loadTools() {
    try {
      const res = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      const { result } = await res.json();
      $('mcp-count').textContent = `(${result.tools.length}, from the server's own tools/list)`;
      $('mcp-tools').tBodies[0].replaceChildren(...result.tools.map(t => el('tr', {},
        el('td', {}, el('code', {}, t.name), el('div', { class: 'sub' }, t.title)),
        el('td', { class: 'small' }, t.description.replace(/ Free: a daily allowance.*$/, '')),
        el('td', { class: 'num small' }, perDay(t._meta?.['com.rektbull/free_per_day'])))));
    } catch (err) { say('mcp-msg', `Couldn't list the tools: ${err.message}`, 'bad'); }
  }

  function fields(input) {
    if (!input) return el('span', { class: 'muted' }, 'none');
    return el('ul', { class: 'fields' }, Object.entries(input.fields).map(([k, f]) => el('li', {}, el('code', {}, k), f.required ? el('span', { class: 'req' }, ' required') : '', ` ${f.text}`)));
  }

  async function load() {
    try {
      const r = await api('GET', '/v1/developers');

      $('prices').tBodies[0].replaceChildren(...r.endpoints.filter(e => e.price).map(e => el('tr', {},
        el('td', {}, el('span', { class: 'name' }, e.summary.split(/[:.,]/)[0])),
        el('td', {}, el('code', {}, `${e.method} ${e.path}`)),
        el('td', { class: 'num' }, e.price.x402 ? e.price.price_usd : '–', e.price.x402_note ? el('div', { class: 'sub' }, 'over $1') : ''),
        el('td', { class: 'num' }, e.price.points ? String(e.price.points) : '–'))));

      $('openapi-link').href = r.openapi.replace(/^https?:\/\/[^/]+/, '');
      $('ref').replaceChildren(...r.groups.map(g => el('div', { class: 'ref-group' },
        el('h3', {}, g.title), el('p', { class: 'muted small' }, g.text),
        el('div', { class: 'tablewrap' }, el('table', { class: 'rank ref' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Endpoint'), el('th', {}, 'What it does'), el('th', {}, 'Input'), el('th', { class: 'num' }, g.id === 'paid' ? 'Price' : 'Free a day'))),
          el('tbody', {}, r.endpoints.filter(e => e.group === g.id).map(e => el('tr', {},
            el('td', {}, el('code', { class: 'nowrap' }, el('span', { class: `verb ${e.method.toLowerCase()}` }, e.method), ` ${e.path}`), e.auth ? el('div', { class: 'sub' }, 'sign in') : ''),
            el('td', { class: 'small' }, e.summary),
            el('td', { class: 'small' }, fields(e.input)),
            el('td', { class: 'num small' }, e.price ? e.price.price_usd : e.free_per_day ? perDay(e.free_per_day) : '–')))))))));
    } catch (err) { say('ref-msg', err.message, 'bad'); }
  }
  load();
  loadTools();
})();
