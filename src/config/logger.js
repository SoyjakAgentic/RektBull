/** One-line JSON logs, which Cloud Run's log viewer reads as structured entries. */
function write(severity, message, fields) {
  const line = { severity, message, time: new Date().toISOString(), ...(fields || {}) };
  (severity === 'ERROR' || severity === 'WARNING' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');
}

module.exports = {
  info: (m, f) => write('INFO', m, f),
  warn: (m, f) => write('WARNING', m, f),
  error: (m, f) => write('ERROR', m, f),
};
