'use strict';
// Platform back-office: risk review, KYC review, audit integrity, ledger reconciliation.
const express = require('express');
const db = require('../db');
const fraud = require('../services/fraud');
const kyc = require('../services/kyc');
const audit = require('../services/audit');
const ledger = require('../services/ledger');
const scheduler = require('../services/scheduler');
const { validate, z } = require('../http');
const { notFound } = require('../lib/errors');

const router = express.Router();

router.get('/stats', (_req, res) => {
  const one = (sql) => db.get(sql).n;
  res.json({
    users: one('SELECT COUNT(*) AS n FROM users'),
    verifiedUsers: one("SELECT COUNT(*) AS n FROM users WHERE kyc_status = 'verified'"),
    groups: one('SELECT COUNT(*) AS n FROM groups'),
    activeGroups: one("SELECT COUNT(*) AS n FROM groups WHERE status = 'active'"),
    totalContributed: one("SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE type = 'contribution' AND status = 'success'"),
    totalPaidOut: one("SELECT COALESCE(SUM(amount),0) AS n FROM transactions WHERE type = 'payout' AND status = 'success'"),
    feeRevenue: ledger.systemAccount(ledger.SYSTEM.fees).balance,
    openFraudFlags: one("SELECT COUNT(*) AS n FROM fraud_flags WHERE status = 'open'"),
    openDisputes: one("SELECT COUNT(*) AS n FROM disputes WHERE status IN ('open','under_review')"),
    pendingKyc: one("SELECT COUNT(*) AS n FROM kyc_records WHERE status = 'pending'"),
  });
});

router.get('/fraud-flags', (req, res) => res.json(fraud.listFlags(req.query.status || 'open')));
router.post('/fraud-flags/:id', validate(z.object({ status: z.enum(['cleared', 'confirmed']) })), (req, res) => {
  fraud.reviewFlag(req.params.id, req.user.id, req.body.status);
  res.json({ ok: true });
});

router.get('/kyc/pending', (_req, res) => res.json(kyc.pending()));
router.post('/kyc/:id/review', validate(z.object({ status: z.enum(['verified', 'rejected']), reason: z.string().max(500).optional() })), (req, res) => {
  kyc.review(req.params.id, req.user.id, req.body);
  res.json({ ok: true });
});

router.post('/users/:id/status', validate(z.object({ status: z.enum(['active', 'suspended']) })), (req, res) => {
  if (!db.get('SELECT 1 FROM users WHERE id = ?', req.params.id)) throw notFound('User');
  db.update('users', req.params.id, { status: req.body.status });
  if (req.body.status === 'suspended') db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date().toISOString(), req.params.id);
  audit.record('admin.user_status', { actorId: req.user.id, entityType: 'user', entityId: req.params.id, data: req.body });
  res.json({ ok: true });
});

router.get('/audit', (req, res) => res.json(audit.list({ entityType: req.query.entityType, entityId: req.query.entityId })));
router.get('/audit/verify', (_req, res) => res.json(audit.verify()));
router.get('/ledger/reconcile', (_req, res) => res.json(ledger.reconcile()));
router.post('/scheduler/run', (_req, res) => res.json(scheduler.runDueJobs()));

module.exports = router;
