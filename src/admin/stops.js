/**
 * Emergency stops, switched in the admin panel. A stop can only halt things
 * RektBull starts by itself; it never moves money, and it never stops a user
 * acting from their own wallet. Read straight from the database each time
 * (settings.read), so a stop takes effect on the trade service's next pass.
 *
 *   auto_trading  no automatic trades or stop-loss / take-profit exits are
 *                 sent; trades already queued are cancelled, not delayed (a
 *                 trade sent later would be at a different price). Trades
 *                 already sent are still confirmed.
 *   auto_yield    no automatic yield deposits or moves are sent; moves
 *                 already sent are still confirmed.
 */
const settings = require('./settings');

const STOPS = {
  auto_trading: {
    name: 'Automatic trading',
    does: 'Stops automatic trades and stop-loss / take-profit exits, and cancels trades waiting to be sent. Users can still trade from their own wallet, and can always revoke.',
  },
  auto_yield: {
    name: 'Automatic yield moves',
    does: 'Stops automatic yield deposits and moves. Users can still withdraw and move from their own wallet, and can always revoke.',
  },
};

class Stopped extends Error {
  constructor(id) { super(`${STOPS[id].name} is paused by RektBull for now. You can still act from your own wallet.`); this.status = 503; this.code = 'stopped'; }
}

const key = id => `stop:${id}`;

/** Is this stop on? (Read from the database, never a cached copy.) */
async function isStopped(id) {
  if (!STOPS[id]) throw new Error(`unknown stop ${id}`);
  return !!(await settings.read(key(id)))?.on;
}

async function refuseIfStopped(id) {
  if (await isStopped(id)) throw new Stopped(id);
}

async function set(id, on, { wallet, reason }) {
  if (!STOPS[id]) throw Object.assign(new Error('No such stop.'), { status: 404 });
  if (typeof on !== 'boolean') throw Object.assign(new Error('on must be true or false.'), { status: 400 });
  await settings.set(key(id), on ? { on: true } : null, { wallet, action: on ? 'stop_on' : 'stop_off', reason });
  return { id, on };
}

async function list() {
  return Promise.all(Object.entries(STOPS).map(async ([id, s]) => ({ id, ...s, on: await isStopped(id) })));
}

module.exports = { STOPS, Stopped, isStopped, refuseIfStopped, set, list };
