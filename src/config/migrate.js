/** Applies migrations/*.sql in name order, each once. `npm run db:migrate`. */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

async function migrate() {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const { rows } = await db.query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map(r => r.name));
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.tx(async c => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    logger.info(`applied ${file}`);
  }
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => { logger.error('migration failed', { error: err.message }); process.exit(1); });
}

module.exports = { migrate };
