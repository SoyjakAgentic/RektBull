/** Automatic Polymarket trading. Filled in with the rules engine and Session Keys (see below in this file's history). */
const env = require('../config/env');
function publicConfig() { return { enabled: false, session_signer: env.polymarketAutoEnabled ? env.sessionKeyAddress || null : null }; }
async function batchSettled() {}
module.exports = { publicConfig, batchSettled };
