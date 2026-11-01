const { Pool } = require('pg');
const env = require('./env');

let pool = null;

function getPool() {
  if (!env.databaseUrl) throw new Error('DATABASE_URL is not set');
  if (!pool) pool = new Pool({ connectionString: env.databaseUrl, max: 10 });
  return pool;
}

const query = (text, params) => getPool().query(text, params);

/** Runs fn(client) inside one transaction; rolls back if it throws. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, tx, getPool };
