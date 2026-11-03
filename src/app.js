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
  app.use(express.json({ limit: '100kb' }));
  // The API is rate-limited per IP; pages and their files aren't (one page load makes many requests).
  app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, skip: req => !req.path.startsWith('/v1/') }));
  // The MetaMask Snap calls these from inside MetaMask (another origin), with its link token in a header.
  // Only the routes a link token may use; no cookies are involved, so any origin is fine.
  const { ALLOWED } = require('./auth/extensionTokens');
  app.use((req, res, next) => {
    if (!ALLOWED.some(([, p]) => p === req.path)) return next();
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '600', 'cross-origin-resource-policy': 'cross-origin' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(optionalAuth);
  app.use(routes);

  // The pages and their files (the wallet signs everything; no page holds a key).
  const pub = path.join(__dirname, '..', 'public');
  app.get('/', (_req, res) => res.redirect(302, '/safety'));
  app.get('/safety', (_req, res) => res.sendFile(path.join(pub, 'safety.html')));
  app.get('/find', (_req, res) => res.sendFile(path.join(pub, 'find.html')));
  app.get('/governance', (_req, res) => res.sendFile(path.join(pub, 'governance.html')));
  app.get('/extension', (_req, res) => res.sendFile(path.join(pub, 'extension.html')));
  // The privacy page names who runs RektBull and how to reach them (OPERATOR_NAME, PRIVACY_CONTACT).
  const privacy = require('fs').readFileSync(path.join(pub, 'privacy.html'), 'utf8');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  app.get('/privacy.html', (_req, res) => res.redirect(301, '/privacy'));
  app.get('/privacy', (_req, res) => {
    const env = require('./config/env');
    res.type('html').send(privacy.replaceAll('{{OPERATOR}}', esc(env.operatorName)).replaceAll('{{CONTACT}}', esc(env.privacyContact)));
  });
  app.get('/trade', (_req, res) => res.sendFile(path.join(pub, 'trade.html')));
  app.get('/vendor/ethers.umd.min.js', (_req, res) => res.sendFile(path.join(path.dirname(require.resolve('ethers')), '..', 'dist', 'ethers.umd.min.js')));
  app.use(express.static(pub, { index: false }));

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
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
