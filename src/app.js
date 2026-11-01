require('express-async-errors');
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
  app.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use(optionalAuth);
  app.use(routes);

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
