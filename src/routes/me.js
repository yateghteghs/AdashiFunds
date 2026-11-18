'use strict';
const express = require('express');
const db = require('../db');
const auth = require('../services/auth');
const kyc = require('../services/kyc');
const reputation = require('../services/reputation');
const referrals = require('../services/referrals');
const wallet = require('../services/wallet');
const groups = require('../services/groups');
const loans = require('../services/loans');
const notifications = require('../services/notifications');
const { validate, publicUser, z, password } = require('../http');
const { SUPPORTED } = require('../lib/i18n');
const config = require('../config');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ user: publicUser(req.user), trust: reputation.trustScore(req.user.id), limits: config.limits[req.user.kyc_tier] });
});

router.patch('/', validate(z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  language: z.enum(SUPPORTED).optional(),
  displayCurrency: z.enum(Object.keys(config.fxRates)).optional(),
  autoWithdraw: z.boolean().optional(),
})), (req, res) => {
  const b = req.body;
  const fields = {};
  if (b.fullName) fields.full_name = b.fullName;
  if (b.language) fields.language = b.language;
  if (b.displayCurrency) fields.display_currency = b.displayCurrency;
  if (b.autoWithdraw !== undefined) fields.auto_withdraw = b.autoWithdraw ? 1 : 0;
  db.update('users', req.user.id, fields);
  res.json({ user: publicUser(db.get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

// Everything the home screen needs in one call.
router.get('/dashboard', (req, res) => {
  const myGroups = groups.listForUser(req.user.id);
  const upcoming = myGroups.filter((g) => g.status === 'active' && g.myOutstanding > 0)
    .map((g) => ({ groupId: g.id, name: g.name, amount: g.contributionAmount, dueAt: g.nextDueAt }));
  const nextPayout = myGroups.filter((g) => g.myPayoutAt && g.myPayoutStatus !== 'paid_out')
    .sort((a, b) => a.myPayoutAt.localeCompare(b.myPayoutAt))[0] || null;
  res.json({
    wallet: wallet.balance(req.user.id),
    groups: myGroups,
    contributionsDue: upcoming,
    nextPayout: nextPayout && { groupId: nextPayout.id, name: nextPayout.name, date: nextPayout.myPayoutAt, amount: nextPayout.contributionAmount * nextPayout.memberCount },
    recentTransactions: wallet.history(req.user.id, { limit: 5 }),
    unreadNotifications: notifications.unreadCount(req.user.id),
    trust: reputation.trustScore(req.user.id),
    loans: loans.listForUser(req.user.id).filter((l) => ['disbursed', 'overdue', 'pending_vote'].includes(l.status)),
  });
});

router.post('/password', validate(z.object({ currentPassword: z.string(), newPassword: password })), (req, res) => {
  auth.changePassword(req.user.id, req.body);
  res.json({ ok: true });
});

router.post('/mfa/setup', (req, res) => res.json(auth.beginMfaSetup(req.user.id)));
router.post('/mfa/enable', validate(z.object({ code: z.string().length(6) })), (req, res) => {
  auth.enableMfa(req.user.id, req.body.code);
  res.json({ ok: true });
});
router.post('/mfa/disable', validate(z.object({ password: z.string(), code: z.string().length(6) })), (req, res) => {
  auth.disableMfa(req.user.id, req.body);
  res.json({ ok: true });
});

router.post('/ussd-pin', validate(z.object({ password: z.string(), pin: z.string().regex(/^\d{4}$/) })), (req, res) => {
  auth.setUssdPin(req.user.id, req.body);
  res.json({ ok: true });
});

router.get('/trust-score', (req, res) => res.json(reputation.trustScore(req.user.id)));

router.get('/kyc', (req, res) => res.json({ status: req.user.kyc_status, tier: req.user.kyc_tier, records: kyc.history(req.user.id) }));
router.post('/kyc', validate(z.object({
  idType: z.enum(Object.keys(kyc.FORMATS)),
  idNumber: z.string().trim().min(6).max(30),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})), async (req, res) => {
  res.status(201).json(await kyc.submit(req.user.id, req.body));
});

router.get('/referrals', (req, res) => res.json(referrals.summary(req.user.id)));
router.get('/loans', (req, res) => res.json(loans.listForUser(req.user.id)));

module.exports = router;
