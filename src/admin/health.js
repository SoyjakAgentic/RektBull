/**
 * The admin panel's health view: the background jobs (late or failing), alert
 * delivery (failed and overdue, by channel), and the services that errored
 * today. All of it is read from what RektBull already records; nothing here
 * calls an outside service (the "test now" buttons do that, one at a time).
 */
const db = require('../config/db');
const jobs = require('./jobs');

async function status() {
  const [jobList, deliveries, failures, disabled] = await Promise.all([
    jobs.status(),
    db.query(`SELECT c.kind,
                     count(*) FILTER (WHERE d.status = 'sent' AND d.sent_at > now() - interval '24 hours')::int AS sent_24h,
                     count(*) FILTER (WHERE d.status = 'failed' AND d.next_attempt_at > now() - interval '24 hours')::int AS failed_24h,
                     count(*) FILTER (WHERE d.status = 'pending' AND d.next_attempt_at < now() - interval '10 minutes')::int AS overdue
                FROM alert_deliveries d JOIN alert_channels c ON c.id = d.channel_id GROUP BY c.kind ORDER BY c.kind`),
    db.query(`SELECT c.kind, d.last_error, max(d.next_attempt_at) AS at, count(*)::int AS n
                FROM alert_deliveries d JOIN alert_channels c ON c.id = d.channel_id
               WHERE d.last_error IS NOT NULL AND d.next_attempt_at > now() - interval '24 hours'
               GROUP BY c.kind, d.last_error ORDER BY at DESC LIMIT 10`),
    db.query(`SELECT kind, count(*)::int AS n FROM alert_channels WHERE disabled_at > now() - interval '7 days' GROUP BY kind`),
  ]);
  const services = (await require('./providers').list()).filter(p => p.errors_today > 0 || p.off).map(p => ({ name: p.name, errors_today: p.errors_today, calls_today: p.calls_today, last_error: p.last_error, off: p.off }));
  const problems = [
    ...jobList.filter(j => j.state === 'late' || j.state === 'failing').map(j => `${j.name}: ${j.state === 'late' ? 'hasn\'t run' : 'failing'}`),
    ...deliveries.rows.filter(d => d.overdue > 0).map(d => `${d.kind} alerts: ${d.overdue} overdue`),
    ...services.filter(s => s.off).map(s => `${s.name}: switched off`),
  ];
  return {
    problems, jobs: jobList,
    alerts: { by_channel: deliveries.rows, recent_errors: failures.rows, channels_switched_off_7d: disabled.rows },
    services_with_errors: services,
    source: 'job_runs, alert_deliveries, alert_channels, provider_usage',
  };
}

module.exports = { status };
