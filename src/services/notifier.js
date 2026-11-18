'use strict';
// Outbound SMS/email delivery. Swap the transport for Termii, Africa's Talking, Twilio, SES, etc.
// by implementing send({ channel, to, message }).
const config = require('../config');

const outbox = []; // memory transport, used by tests and dev tooling

const transports = {
  console: {
    async send({ channel, to, message }) {
      console.log(`[notifier:${channel}] -> ${to}: ${message}`);
    },
  },
  memory: {
    async send(msg) { outbox.push({ ...msg, at: new Date().toISOString() }); },
  },
};

function send(msg) {
  const t = transports[config.notifier] || transports.console;
  // Fire-and-forget: delivery failures must never roll back a financial transaction.
  Promise.resolve(t.send(msg)).catch((err) => console.error('[notifier] delivery failed', err.message));
}

module.exports = {
  sms: (to, message) => send({ channel: 'sms', to, message }),
  email: (to, message) => send({ channel: 'email', to, message }),
  outbox,
};
