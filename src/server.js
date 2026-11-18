'use strict';
const config = require('./config');
const db = require('./db');
const { createApp } = require('./app');
const scheduler = require('./services/scheduler');
const ledger = require('./services/ledger');

db.open();
for (const name of Object.values(ledger.SYSTEM)) ledger.systemAccount(name);

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`AdashiFunds running on http://localhost:${config.port} (${config.env}, payments: ${config.paymentProvider})`);
});

if (process.env.DISABLE_SCHEDULER !== 'true') {
  scheduler.start(config.schedulerIntervalMs);
  scheduler.runDueJobs();
}

function shutdown() {
  scheduler.stop();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
