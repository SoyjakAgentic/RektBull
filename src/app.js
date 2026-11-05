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
  const render = (file, current, route = current) => fs.readFileSync(path.join(pub, file), 'utf8')
    .replace('<!--#meta-->', seo.head(route, base))
    .replace('<!--#header-->', current === '/' ? HEADER.replace('<a class="logo" href="/"', '<a class="logo" href="/" aria-current="page"') : HEADER.replace(`<a href="${current}">`, `<a href="${current}" aria-current="page">`))
    .replace(/<!--#footer(?::([\s\S]*?))?-->/, (_, note) => FOOTER.replace('{{NOTE}}', (note || NOTE).trim()));
  const PAGES = { '/': 'home.html', '/discover': 'discover.html', '/markets': 'markets.html', '/opportunities': 'opportunities.html', '/portfolio': 'portfolio.html', '/research': 'research.html', '/safety': 'safety.html', '/find': 'find.html', '/trade': 'trade.html', '/governance': 'governance.html', '/extension': 'extension.html', '/developers': 'developers.html', '/agents': 'agents.html' };
  // Find money and Governance sit under Opportunities in the menu.
  const MENU = { '/find': '/opportunities', '/governance': '/opportunities' };
  for (const [route, file] of Object.entries(PAGES)) {
    const html = render(file, MENU[route] || route, route);
    app.get(route, (_req, res) => res.type('html').send(html));
  }
  // The privacy page names who runs RektBull and how to reach them (OPERATOR_NAME, PRIVACY_CONTACT).
  const privacy = render('privacy.html', '/privacy');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // One address per page: /safety.html and the like go to /safety (the files are templates, not pages).
  for (const [route, file] of [...Object.entries(PAGES), ['/privacy', 'privacy.html']]) {
    app.get(`/${file}`, (_req, res) => res.redirect(301, route));
  }
  app.get('/robots.txt', (_req, res) => res.type('text/plain').set('cache-control', 'public, max-age=3600').send(seo.robots(base)));
  app.get('/sitemap.xml', (_req, res) => res.type('application/xml').set('cache-control', 'public, max-age=3600').send(seo.sitemap(base)));
  app.get('/favicon.ico', (_req, res) => res.redirect(301, '/favicon-48.png'));
  app.get('/privacy', (_req, res) => {
    const env = require('./config/env');
    res.type('html').send(privacy.replaceAll('{{OPERATOR}}', esc(env.operatorName)).replaceAll('{{CONTACT}}', esc(env.privacyContact)));
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
  app.use(express.static(pub, { index: false }));

  // A page that doesn't exist: a page for people, JSON for the API.
  const notFound = render('404.html', '/404', '/404');
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
