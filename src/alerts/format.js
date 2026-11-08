/**
 * One alert, written for each channel: a short title, the reasons with their
 * sources, and a link to review it. Text only; the email's HTML is built from
 * escaped text, so nothing in an alert is ever read as markup.
 */
const env = require('../config/env');

const short = a => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const SEVERITY = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', low: 'LOW', info: 'INFO' };

function reviewUrl(alert) {
  return `${env.publicUrl}/safety?wallet=${encodeURIComponent(alert.wallet)}#approvals-card`;
}

function reasons(alert) {
  const list = alert.detail?.reasons || (alert.detail?.risky || []).flatMap(r => r.reasons || []).slice(0, 4);
  return list.slice(0, 4).map(r => `• ${r.text} (${r.source})`);
}

/** Where the AI agents' own alerts link (src/services/myAgents.js). */
const AGENT_LINKS = {
  checkup: { action: 'See your checkup', path: a => `/?wallet=${encodeURIComponent(a.wallet)}#results` },
  claimable: { action: 'Review and claim', path: a => `/find?wallet=${encodeURIComponent(a.wallet)}` },
  token_watch: { action: 'See the token check', path: a => `/safety?chain=${encodeURIComponent(a.detail?.token?.chain || '')}&token=${encodeURIComponent(a.detail?.token?.token || '')}#check-card` },
  launch_safety: { action: 'See the launch check', path: a => `/safety?chain=${encodeURIComponent(a.detail?.token?.chain || '')}&token=${encodeURIComponent(a.detail?.token?.token || '')}#check-card` },
  trade_exit: { action: 'See the trade', path: () => '/trade' },
};

/** { subject, text, url } for an alert. */
function message(alert) {
  if (alert.kind === 'pass_renewal') {
    return { subject: `RektBull: ${alert.title}`.slice(0, 150), text: [alert.title, ...(alert.detail?.reasons || []).map(r => r.text)].join('\n'), url: `${env.publicUrl}/safety#pro-card`, action: 'Renew Safety Pro' };
  }
  if (alert.kind === 'digest_draft') {
    return { subject: `RektBull: ${alert.title}`.slice(0, 150), text: [alert.title, ...(alert.detail?.reasons || []).map(r => r.text)].join('\n'), url: `${env.publicUrl}/research#review`, action: 'Review and publish' };
  }
  const lines = [
    `${SEVERITY[alert.severity] || alert.severity}: ${alert.title}`,
    `Wallet ${short(alert.wallet)}`,
    ...reasons(alert),
  ];
  const agent = AGENT_LINKS[alert.kind];
  if (agent) {
    return {
      subject: `RektBull ${alert.severity === 'info' || alert.severity === 'low' ? '' : `${SEVERITY[alert.severity]} `}alert: ${alert.title}`.slice(0, 150),
      text: lines.join('\n'), url: `${env.publicUrl}${agent.path(alert)}`, action: agent.action,
    };
  }
  const yieldRisk = alert.kind === 'yield_risk';
  const governance = alert.kind === 'governance';
  const url = alert.kind === 'depeg' ? `${env.publicUrl}/safety#monitor-card`
    : yieldRisk ? `${env.publicUrl}/find?wallet=${encodeURIComponent(alert.wallet)}#yield-card`
      : governance ? `${env.publicUrl}/governance?wallet=${encodeURIComponent(alert.wallet)}` : reviewUrl(alert);
  return {
    subject: `RektBull ${alert.severity === 'info' ? '' : `${SEVERITY[alert.severity]} `}alert: ${alert.title}`.slice(0, 150),
    text: lines.join('\n'),
    url,
    action: alert.kind === 'depeg' ? 'Open RektBull' : yieldRisk ? 'Review and withdraw' : governance ? 'Review and vote' : 'Review and revoke',
  };
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The email body as HTML, from escaped text only. */
function emailHtml(m, unsubscribeUrl) {
  const body = m.text.split('\n').map(l => `<p style="margin:6px 0">${escapeHtml(l)}</p>`).join('');
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#15181d">${body}`
    + `<p style="margin:16px 0"><a href="${escapeHtml(m.url)}" style="background:#1f6feb;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">${escapeHtml(m.action)}</a></p>`
    + `<p style="font-size:12px;color:#5d6673">RektBull never asks for your seed phrase or keys, and never sends links that ask you to sign in to a wallet you didn't open yourself. `
    + `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#5d6673">Stop these emails</a>.</p></div>`;
}

module.exports = { message, emailHtml, escapeHtml, reviewUrl };
