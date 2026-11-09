require('express-async-errors');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./config/logger');
const { optionalAuth } = require('./middleware/auth');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Cloud Run's load balancer
  app.use(helmet());
  app.use(require('compression')()); // gzip: about half the bytes on a first visit
  app.use(express.json({ limit: '100kb' }));
  // The API is rate-limited per IP; pages and their files aren't (one page load makes many requests).
  app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, skip: req => !req.path.startsWith('/v1/') && req.path !== '/mcp' }));
  // What the owners set in the admin panel (prices, agents, switches): read again at most once a minute,
  // and today's prices put into every page and text file ({{price:...}} in the templates; payments/catalog fill()).
  const adminSettings = require('./admin/settings');
  const { fill } = require('./payments/catalog');
  const { stripPage } = require('./admin/agentStates');
  app.use((req, res, next) => {
    const send = res.send;
    res.send = function (body) {
      const type = String(res.get('content-type') || '');
      if (typeof body === 'string' && /html/.test(type)) body = stripPage(body).replace('<!--#banner-->', require('./admin/banner').html());
      if (typeof body === 'string' && body.includes('{{') && /html|text\/plain/.test(type)) body = fill(body);
      return send.call(this, body);
    };
    adminSettings.fresh().then(() => next(), next);
  });
  // The MetaMask Snap calls these from inside MetaMask (another origin), with its link token in a header.
  // Only the routes a link token may use; no cookies are involved, so any origin is fine.
  const { ALLOWED } = require('./auth/extensionTokens');
  app.use((req, res, next) => {
    if (!ALLOWED.some(([, p]) => p === req.path)) return next();
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600', 'cross-origin-resource-policy': 'cross-origin' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  // The MCP server (and the API's reference) are for any client, browsers on other sites included:
  // a bearer token, never a cookie, so no origin can act as a signed-in user.
  app.use(['/mcp', '/v1/openapi.json', '/v1/developers'], (req, res, next) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600', 'cross-origin-resource-policy': 'cross-origin' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(optionalAuth);
  app.use(require('./mcp/server').router);
  app.use(routes);

  // The pages and their files (the wallet signs everything; no page holds a key).
  // Every page shares one header and footer (src/pages), put in when the app starts.
  const pub = path.join(__dirname, '..', 'public');
  const fs = require('fs');
  const partial = name => fs.readFileSync(path.join(__dirname, 'pages', name), 'utf8');
  const HEADER = partial('header.html');
  const FOOTER = partial('footer.html');
  const NOTE = 'An automated check of known patterns, not financial advice or proof of safety.';
  const seo = require('./pages/seo');
  const base = require('./config/env').publicUrl;
  // `route` is the page's own address (its title, canonical and sitemap entry); `current` is what the menu marks.
  const env = require('./config/env');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shell = (html, current) => html
    .replace('<!--#header-->', current === '/' ? HEADER.replace('<a class="logo" href="/"', '<a class="logo" href="/" aria-current="page"') : HEADER.replace(`<a href="${current}">`, `<a href="${current}" aria-current="page">`))
    .replace(/<!--#footer(?::([\s\S]*?))?-->/, (_, note) => FOOTER.replace('{{NOTE}}', (note || NOTE).trim()));
  // Each page: its <head> (seo.js), its Questions section before </main>, the shared header and footer,
  // the operator's name and contact where a page names them, and FAQ data read from the finished page.
  const render = (file, current, route = current) => seo.withFaqData(shell(fs.readFileSync(path.join(pub, file), 'utf8')
    .replace('<!--#meta-->', seo.head(route, base))
    .replace('</main>', `${seo.faqSection(route)}</main>`), current)
    .replaceAll('{{OPERATOR}}', esc(env.operatorName)).replaceAll('{{CONTACT}}', esc(env.privacyContact)));
  const { glance } = require('./pages/glance');
  // Pages with an "At a glance" block get it filled at request time (cached; never holds the page up).
  const send = html => (html.includes('<!--#facts-->')
    ? async (req, res, next) => { try { res.type('html').send(html.replace('<!--#facts-->', await glance(req.path))); } catch (err) { next(err); } }
    : (_req, res) => res.type('html').send(html));
  const PAGES = { '/': 'home.html', '/discover': 'discover.html', '/markets': 'markets.html', '/opportunities': 'opportunities.html', '/portfolio': 'portfolio.html', '/research': 'research.html', '/safety': 'safety.html', '/find': 'find.html', '/trade': 'trade.html', '/governance': 'governance.html', '/extension': 'extension.html', '/developers': 'developers.html', '/agents': 'agents.html', '/about': 'about.html', '/privacy': 'privacy.html' };
  // Find money and Governance sit under Opportunities in the menu.
  const MENU = { '/find': '/opportunities', '/governance': '/opportunities' };
  for (const [route, file] of Object.entries(PAGES)) {
    app.get(route, send(render(file, MENU[route] || route, route)));
  }
  // The admin panel: not in the menu or the sitemap, noindex; its API checks the wallet (src/routes/admin.js).
  app.get('/admin', send(render('admin.html', '/admin', '/admin')));
  // One address per page: /safety.html and the like go to /safety (the files are templates, not pages).
  for (const [route, file] of Object.entries(PAGES)) {
    app.get(`/${file}`, (_req, res) => res.redirect(301, route));
  }

  // Each published weekly digest at its own address, rendered on the server (src/pages/digestPage.js).
  const digestShell = fs.readFileSync(path.join(pub, 'digest.html'), 'utf8');
  const published = async () => (env.databaseUrl ? require('./services/research').digests().catch(() => []) : []);
  app.get('/research/:week', async (req, res, next) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.week) || !env.databaseUrl) return next();
    try {
      const research = require('./services/research');
      const d = await research.digest(req.params.week).catch(err => { if (err instanceof research.ResearchRefused) return null; throw err; });
      if (!d) return next();
      const p = require('./pages/digestPage').page(d, await published(), base);
      res.type('html').set('cache-control', 'public, max-age=300').send(seo.withFaqData(shell(digestShell.replace('<!--#meta-->', seo.headFor(p.head)).replace('<!--#body-->', p.body), '/research')));
    } catch (err) { next(err); }
  });

  // Protocol records: /dapps and /dapps/<slug>, rendered on the server (src/pages/dappPage.js).
  const dappPage = require('./pages/dappPage');
  const records = async () => dappPage.eligible(await require('./providers/llama').protocols());
  const recordShell = digestShell.replace(/<!--#footer:[\s\S]*?-->/, '<!--#footer:Facts from DefiLlama and Merkl, each with its source. A record is never proof that a protocol is safe. Not advice.-->');
  app.get('/dapps', async (req, res, next) => {
    try {
      const p = dappPage.index(await records(), base);
      res.type('html').set('cache-control', 'public, max-age=600').send(seo.withFaqData(shell(recordShell.replace('<!--#meta-->', seo.headFor(p.head)).replace('<!--#body-->', p.body), '/discover')));
    } catch (err) { next(err); }
  });
  app.get('/dapps/:slug', async (req, res, next) => {
    if (!/^[a-z0-9-]{1,80}$/.test(req.params.slug)) return next();
    try {
      const d = await dappPage.gather(req.params.slug);
      if (!d) return next();
      const p = dappPage.page(d, base);
      res.type('html').set('cache-control', 'public, max-age=600').send(seo.withFaqData(shell(recordShell.replace('<!--#meta-->', seo.headFor(p.head)).replace('<!--#body-->', p.body), '/discover')));
    } catch (err) { next(err); }
  });

  // One page per AI agent: /agents/<slug>, rendered on the server (src/pages/agentPage.js).
  const agentPage = require('./pages/agentPage');
  const agentShell = digestShell.replace(/<!--#footer:[\s\S]*?-->/, '<!--#footer:Agents send what RektBull\'s checks found, each with its source; a clean result is never proof that something is safe. Not advice.-->');
  app.get('/agents/:slug', (req, res, next) => {
    const p = agentPage.page(req.params.slug, base);
    if (!p) return next();
    res.type('html').set('cache-control', 'public, max-age=600').send(seo.withFaqData(shell(agentShell.replace('<!--#meta-->', seo.headFor(p.head)).replace('<!--#body-->', p.body), '/agents')));
  });

  const text = (type, maxAge) => (_req, res, body) => res.type(type).set('cache-control', `public, max-age=${maxAge}`).send(body);
  app.get('/robots.txt', (req, res) => text('text/plain', 3600)(req, res, seo.robots(base)));
  app.get('/sitemap.xml', async (req, res) => {
    const [weeks, dapps] = await Promise.all([published(), records().catch(() => [])]);
    text('application/xml', 3600)(req, res, seo.sitemap(base, [
      ...weeks.map(w => ({ loc: `${base}/research/${w.week_start}`, lastmod: w.published_at ? new Date(w.published_at).toISOString().slice(0, 10) : null })),
      ...agentPage.list().map(a => ({ loc: `${base}/agents/${a.slug}` })),
      ...(dapps.length ? [{ loc: `${base}/dapps` }] : []),
      ...dapps.map(p => ({ loc: `${base}/dapps/${p.slug}` })),
    ]));
  });
  app.get('/llms.txt', async (req, res) => text('text/plain; charset=utf-8', 3600)(req, res, seo.llms(base, await published())));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon-48.png'));
  // IndexNow's proof that the site is ours (src/services/indexnow.js): the key, at /<key>.txt.
  app.get('/:file.txt', (req, res, next) => {
    const key = require('./services/indexnow').key();
    if (!key || req.params.file !== key) return next();
    text('text/plain', 86400)(req, res, key);
  });
  app.get('/vendor/ethers.umd.min.js', (_req, res) => res.sendFile(path.join(path.dirname(require.resolve('ethers')), '..', 'dist', 'ethers.umd.min.js')));
  // Fonts are served from here, not a font CDN, so no visitor's address goes to a third party.
  const FONTS = {
    'bricolage.woff2': ['@fontsource-variable/bricolage-grotesque', 'bricolage-grotesque-latin-wght-normal.woff2'],
    'plex-sans-400.woff2': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
    'plex-sans-500.woff2': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2'],
    'plex-sans-600.woff2': ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
    'plex-mono-400.woff2': ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
    'plex-mono-500.woff2': ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2'],
  };
  app.get('/fonts/:file', (req, res) => {
    const f = FONTS[req.params.file];
    if (!f) return res.status(404).end();
    res.set('cache-control', 'public, max-age=31536000, immutable');
    res.sendFile(path.join(path.dirname(require.resolve(`${f[0]}/package.json`)), 'files', f[1]));
  });
  // A page that doesn't exist: a page for people, JSON for the API. The templates themselves aren't pages.
  const notFound = render('404.html', '/404', '/404');
  app.get(['/digest.html', '/404.html'], (_req, res) => res.status(404).type('html').send(notFound));
  // The stylesheet, scripts and images: kept 10 minutes by browsers, so a deploy shows within minutes.
  app.use(express.static(pub, { index: false, maxAge: '10m' }));

  app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/v1/') && req.accepts(['json', 'html']) === 'html') return res.status(404).type('html').send(notFound);
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler);
  return app;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) logger.error('request failed', { path: req.path, error: err.message, stack: err.stack });
  res.status(status).json({ error: status >= 500 ? 'server_error' : 'request_failed', message: status >= 500 && status !== 503 ? 'Something went wrong on our side.' : err.message });
}

module.exports = { createApp, errorHandler };
