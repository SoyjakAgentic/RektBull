/**
 * One image, two roles:
 *   web    - the HTTP API
 *   worker - the deposit watcher and housekeeping
 *   all    - both (local development)
 */
const env = require('./config/env');
const logger = require('./config/logger');
const { migrate } = require('./config/migrate');
const { createApp } = require('./app');
const watcher = require('./payments/watcher');
const { purgeExpired } = require('./lib/cache');

async function main() {
  if (env.databaseUrl) await migrate();
  else logger.warn('DATABASE_URL is not set: sign-in, payments and the cache database are off');

  const role = env.serviceRole;
  if (role === 'web' || role === 'all') {
    createApp().listen(env.port, () => logger.info(`RektBull API listening on ${env.port}`));
  }
  if ((role === 'worker' || role === 'all') && env.databaseUrl) {
    watcher.start();
    setInterval(() => purgeExpired().catch(err => logger.warn('cache purge failed', { error: err.message })), 60 * 60 * 1000);
    logger.info('worker started: deposit watcher on', { chains: env.paymentChains });
    if (role === 'worker') {
      // Cloud Run needs something listening on PORT even for a worker.
      require('http').createServer((_q, r) => { r.writeHead(200); r.end('ok'); }).listen(env.port);
    }
  }
}

main().catch(err => {
  logger.error('startup failed', { error: err.message });
  process.exit(1);
});
