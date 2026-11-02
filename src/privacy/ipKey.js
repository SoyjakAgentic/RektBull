/**
 * IP addresses are only used to cap free use per place (free points, free
 * previews). They're stored as a keyed hash, never as the address: enough to
 * count, not enough to read back. Rows using it are deleted after 40 days
 * (src/privacy/retention.js).
 */
const crypto = require('crypto');
const env = require('../config/env');

const ipSubject = ip => `iph:${crypto.createHmac('sha256', `ip-cap:${env.jwtSecret || 'unset'}`).update(String(ip || '')).digest('base64url').slice(0, 22)}`;

module.exports = { ipSubject };
