// mm-snap build/serve config. SNAP_ENV=test builds a bundle that accepts a
// test API address when linked (only the test suite uses it; `npm run build`
// always makes the production bundle, which talks only to rektbull.com).
module.exports = {
  input: './src/index.jsx',
  server: { port: 8081 },
  environment: { SNAP_ENV: process.env.SNAP_ENV || 'production' },
  stats: { builtIns: false },
};
