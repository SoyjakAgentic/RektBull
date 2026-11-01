/**
 * One image, several roles:
 *   web    - the HTTP API
 *   worker - the deposit watcher and housekeeping
 *   trade  - the trade service: confirms trades, and (milestone 2) is the only
 *            role allowed to sign with RektBull's KMS keys
 *   all    - all three (local development)
 */
const env = require('./config/env');
const logger = require('./config/logger');
const { migrate } = require('./config/migrate');
const { createApp } = require('./app');
const watcher = require('./payments/watcher');
const { purgeExpired } = require('./lib/cache');
const tradePositions = require('./trade/positions');

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
  }
  if ((role === 'trade' || role === 'all') && env.databaseUrl) {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await tradePositions.tick(); } catch (err) { logger.error('trade tick failed', { error: err.message }); } finally { busy = false; }
    }, env.tradeTickMs);
    logger.info('trade service started');
  }
  if (role === 'worker' || role === 'trade') {
    // Cloud Run needs something listening on PORT even for a background service.
    require('http').createServer((_q, r) => { r.writeHead(200); r.end('ok'); }).listen(env.port);
  }
}

main().catch(err => {
  logger.error('startup failed', { error: err.message });
  if (/ECONNREFUSED|ENOTFOUND|password authentication|does not exist/i.test(err.message)) {
    console.error(`\nRektBull could not reach its database (${err.message}).\n` +
      'Check that Postgres is running and that DATABASE_URL in .env points at it, or use `docker compose up`.\n' +
      'Until it starts, http://localhost:8080 will say the page can\'t be reached.\n');
  }
  process.exit(1);
});
