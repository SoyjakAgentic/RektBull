/**
 * One image, several roles:
 *   web    - the HTTP API
 *   worker - the deposit watcher, the risk monitor and housekeeping
 *   trade  - the trade service: confirms trades, runs exits, and sends
 *            automatic trades; the only role allowed to sign with RektBull's KMS key
 *   all    - all three (local development)
 */
const env = require('./config/env');
const logger = require('./config/logger');
const { migrate } = require('./config/migrate');
const { createApp } = require('./app');
const watcher = require('./payments/watcher');
const { purgeExpired } = require('./lib/cache');
const tradePositions = require('./trade/positions');
const jobs = require('./admin/jobs');

async function main() {
  if (env.databaseUrl) await migrate();
  else logger.warn('DATABASE_URL is not set: sign-in, payments and the cache database are off');

  const role = env.serviceRole;
  if (role === 'web' || role === 'all') {
    createApp().listen(env.port, () => logger.info(`RektBull API listening on ${env.port}`));
  }
  if (role !== 'web' && env.databaseUrl) {
    // Prices, agents' states and switches set in the admin panel: read again every minute (the web role does it per request).
    setInterval(() => require('./admin/settings').fresh(), 60 * 1000);
  }
  if ((role === 'worker' || role === 'all') && env.databaseUrl) {
    // Each job through admin/jobs.run: never two at once, and when it last worked is kept for the admin panel's health view.
    const job = (name, ms, fn) => setInterval(() => jobs.run(name, fn), ms);
    const deposits = () => jobs.run('deposits', () => watcher.tick());
    deposits();
    setInterval(deposits, env.watcherIntervalMs);
    job('cache_purge', 60 * 60 * 1000, () => purgeExpired());
    // Deletes data past the periods on the privacy page (src/privacy/retention.js).
    job('retention', 60 * 60 * 1000, () => require('./privacy/retention').purge());
    // NOWPayments: payments under way, read back every 5 minutes so a lost notification is caught up.
    job('nowpayments', 5 * 60 * 1000, () => require('./payments/nowpayments').reconcile());
    // DAO votes opening or closing for watched wallets (Safety Pro), hourly.
    job('governance_alerts', 60 * 60 * 1000, () => require('./services/governance').alertTick());
    // Research: last week's digest, made once on Monday from 06:00 UTC (checked hourly); the newsletter after it.
    job('newsletter', 5 * 60 * 1000, () => require('./services/newsletter').tick());
    job('research', 60 * 60 * 1000, () => require('./services/research').tick());
    // Safety Pro renewal reminders, hourly.
    job('pass_reminders', 60 * 60 * 1000, () => require('./payments/reminders').tick());
    // The yield risk watcher: every venue, every 5 minutes (src/yield/risk.js).
    job('yield_risk', 5 * 60 * 1000, () => require('./yield/risk').tick());
    // The risk monitor: a few due wallets every 5 minutes (each is checked once a day).
    job('monitor', 5 * 60 * 1000, () => require('./services/monitor').tick());
    // AI agents that run on a schedule (wallet checkup, claim assistant, token watch): the due ones, every 5 minutes.
    job('agents', 5 * 60 * 1000, () => require('./services/myAgents').tick());
    // Channel Poster: new drafts for project channels, sent to their admins to approve, every 30 minutes.
    job('channel_poster', 30 * 60 * 1000, () => require('./services/channelPoster').tick());
    // Alerts out to Telegram, email and browser push, every 20 seconds.
    job('alerts', 20 * 1000, () => require('./alerts/dispatch').tick());
    logger.info('worker started: deposit watcher and risk monitor', { chains: env.paymentChains });
  }
  if ((role === 'trade' || role === 'all') && env.databaseUrl) {
    setInterval(() => jobs.run('trade', async () => {
      await tradePositions.tick(); // approve-each trades the user's wallet sent
      await require('./trade/exits').tick(); // stop-loss / take-profit on automatic positions
      await require('./trade/autonomous').tick(); // send and confirm automatic trades
      await require('./yield/auto').tick(); // automatic yield rebalancing (does nothing unless YIELD_AUTO_ENABLED)
    }), env.tradeTickMs);
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
