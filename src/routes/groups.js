'use strict';
const express = require('express');
const groups = require('../services/groups');
const governance = require('../services/governance');
const loans = require('../services/loans');
const { validate, z, kobo, id } = require('../http');

const router = express.Router();

const settings = {
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500).optional(),
  contributionAmount: kobo,
  frequency: z.enum(groups.FREQUENCIES),
  maxMembers: z.number().int().min(2).max(100),
  payoutOrder: z.enum(['join_order', 'random', 'manual']).optional(),
  latePenaltyBps: z.number().int().min(0).max(5000).optional(),
  gracePeriodHours: z.number().int().min(0).max(336).optional(),
  loanInterestBps: z.number().int().min(0).max(3000).optional(),
  approvalThresholdBps: z.number().int().min(5001).max(10000).optional(),
  payoutTiming: z.enum(['when_complete', 'on_due_date']).optional(),
  isPublic: z.boolean().optional(),
  requireKyc: z.boolean().optional(),
};
const createSchema = z.object(settings);
const updateSchema = z.object(settings).partial();

router.get('/', (req, res) => res.json(groups.listForUser(req.user.id)));
router.get('/public', (_req, res) => res.json(groups.listPublic()));

router.post('/', validate(createSchema), (req, res) => {
  const g = groups.createGroup(req.user.id, req.body);
  res.status(201).json(groups.getGroupDetail(g.id, req.user.id));
});

router.post('/join', validate(z.object({ inviteCode: z.string().optional(), groupId: id.optional() })
  .refine((b) => b.inviteCode || b.groupId, 'Provide an invite code')), (req, res) => {
  const g = groups.joinGroup(req.user.id, req.body);
  res.json(groups.getGroupDetail(g.id, req.user.id));
});

router.get('/:id', (req, res) => res.json(groups.getGroupDetail(req.params.id, req.user.id)));

router.patch('/:id', validate(updateSchema), (req, res) => {
  groups.updateSettings(req.user.id, req.params.id, req.body);
  res.json(groups.getGroupDetail(req.params.id, req.user.id));
});

router.post('/:id/start', validate(z.object({ firstDueAt: z.string().optional() })), (req, res) => {
  res.json(groups.startGroup(req.user.id, req.params.id, req.body));
});

router.post('/:id/leave', (req, res) => {
  groups.leaveGroup(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.post('/:id/cancel', (req, res) => {
  groups.cancelGroup(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.put('/:id/payout-order', validate(z.object({ userIds: z.array(id).min(2) })), (req, res) => {
  groups.setPayoutOrder(req.user.id, req.params.id, req.body.userIds);
  res.json(groups.getGroupDetail(req.params.id, req.user.id));
});

router.put('/:id/auto-debit', validate(z.object({ enabled: z.boolean() })), (req, res) => {
  groups.setAutoDebit(req.user.id, req.params.id, req.body.enabled);
  res.json({ ok: true });
});

router.post('/:id/contributions', validate(z.object({ contributionId: id.optional() })), (req, res) => {
  const r = groups.contribute(req.user.id, req.params.id, { contributionId: req.body.contributionId });
  res.status(201).json({ ...r, group: groups.getGroupDetail(req.params.id, req.user.id) });
});

router.post('/:id/close-round', (req, res) => {
  groups.closeRound(req.user.id, req.params.id);
  res.json(groups.getGroupDetail(req.params.id, req.user.id));
});

router.get('/:id/messages', validate(z.object({ after: z.string().optional() }), 'query'), (req, res) => {
  res.json(groups.listMessages(req.user.id, req.params.id, req.validQuery));
});
router.post('/:id/messages', validate(z.object({ body: z.string().trim().min(1).max(2000) })), (req, res) => {
  res.status(201).json(groups.postMessage(req.user.id, req.params.id, req.body.body));
});

router.get('/:id/proposals', (req, res) => res.json(governance.listForGroup(req.params.id, req.user.id)));
router.post('/:id/proposals', validate(z.object({
  type: z.enum(['rule_change', 'remove_member']),
  title: z.string().trim().min(3).max(200),
  payload: z.object({ changes: updateSchema.optional(), userId: id.optional() }),
})), (req, res) => {
  res.status(201).json(governance.create(req.params.id, req.user.id, req.body));
});

router.get('/:id/loans', (req, res) => res.json(loans.listForGroup(req.params.id, req.user.id)));
router.post('/:id/loans', validate(z.object({
  amount: kobo, termDays: z.number().int().min(1).max(180).optional(), reason: z.string().max(500).optional(),
})), (req, res) => {
  res.status(201).json(loans.request(req.user.id, req.params.id, req.body));
});

router.post('/:id/reserve', validate(z.object({ amount: kobo })), (req, res) => {
  res.status(201).json(loans.fundReserve(req.user.id, req.params.id, req.body.amount));
});

module.exports = router;
