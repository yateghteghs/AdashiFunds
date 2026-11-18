'use strict';
// Unauthenticated inbound integrations: payment webhooks and the USSD gateway callback.
const express = require('express');
const config = require('../config');
const wallet = require('../services/wallet');
const ussd = require('../services/ussd');
const audit = require('../services/audit');
const { providers } = require('../services/payments');

const router = express.Router();

// Raw body is required to verify the provider's HMAC signature.
router.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const p = providers[req.params.provider];
  if (!p || (p.name === 'mock' && config.isProd)) return res.status(404).end();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!p.verifyWebhook(raw, req.headers)) return res.status(401).json({ error: { code: 'bad_signature', message: 'Invalid signature' } });
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  const evt = p.parseWebhook(body);
  audit.record('webhook.received', { entityType: 'transaction', entityId: evt.reference, data: { provider: p.name, event: evt.event } });
  try {
    if (evt.event === 'deposit.success') wallet.settleDeposit(evt.reference, evt.amount);
    else if (evt.event === 'transfer.success') wallet.completeWithdrawal(evt.reference, true);
    else if (evt.event === 'transfer.failed') wallet.completeWithdrawal(evt.reference, false, 'bank transfer failed');
  } catch (err) {
    // Acknowledge anyway so the provider doesn't retry forever; the audit log has the details.
    audit.record('webhook.error', { entityType: 'transaction', entityId: evt.reference, data: { message: err.message } });
  }
  res.json({ received: true });
});

// Africa's Talking-style USSD callback (application/x-www-form-urlencoded), plain-text response.
router.post('/ussd', express.urlencoded({ extended: false }), (req, res) => {
  res.type('text/plain').send(ussd.handle(req.body || {}));
});

module.exports = router;
