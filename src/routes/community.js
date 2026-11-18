'use strict';
// Proposals, loans, disputes, notifications, leaderboard, support and content.
const express = require('express');
const governance = require('../services/governance');
const loans = require('../services/loans');
const disputes = require('../services/disputes');
const notifications = require('../services/notifications');
const referrals = require('../services/referrals');
const support = require('../services/support');
const { validate, z, kobo, id } = require('../http');

const router = express.Router();

router.get('/proposals/:id', (req, res) => {
  const p = governance.get(req.params.id, req.user.id);
  require('../services/groups').requireMember(p.groupId, req.user.id);
  res.json(p);
});
router.post('/proposals/:id/votes', validate(z.object({ choice: z.enum(['yes', 'no']) })), (req, res) => {
  res.json(governance.vote(req.params.id, req.user.id, req.body.choice));
});

router.post('/loans/:id/repayments', validate(z.object({ amount: kobo.optional() })), (req, res) => {
  res.json(loans.repay(req.user.id, req.params.id, req.body));
});

router.get('/disputes', (req, res) => res.json(disputes.list(req.user.id)));
router.post('/disputes', validate(z.object({
  groupId: id.optional(), againstUserId: id.optional(), transactionId: z.string().optional(),
  category: z.enum(disputes.CATEGORIES), description: z.string().trim().min(10).max(4000),
})), (req, res) => res.status(201).json(disputes.create(req.user.id, req.body)));
router.get('/disputes/:id', (req, res) => res.json(disputes.get(req.params.id, req.user.id)));
router.post('/disputes/:id/messages', validate(z.object({ body: z.string().trim().min(1).max(4000), evidenceRef: z.string().max(500).optional() })), (req, res) => {
  res.status(201).json(disputes.addMessage(req.params.id, req.user.id, req.body));
});
router.post('/disputes/:id/status', validate(z.object({
  status: z.enum(['under_review', 'resolved', 'rejected']), resolution: z.string().max(4000).optional(),
})), (req, res) => res.json(disputes.setStatus(req.params.id, req.user.id, req.body)));

router.get('/notifications', validate(z.object({ unread: z.enum(['true', 'false']).optional() }), 'query'), (req, res) => {
  res.json({ items: notifications.list(req.user.id, { unreadOnly: req.validQuery.unread === 'true' }), unread: notifications.unreadCount(req.user.id) });
});
router.post('/notifications/read', validate(z.object({ ids: z.array(id).optional() })), (req, res) => {
  notifications.markRead(req.user.id, req.body.ids);
  res.json({ ok: true });
});

router.get('/leaderboard', (_req, res) => res.json(referrals.leaderboard()));

router.post('/support/assistant', validate(z.object({ question: z.string().trim().min(2).max(1000) })), (req, res) => {
  res.json(support.answer(req.body.question));
});
router.get('/support/tickets', (req, res) => res.json(support.listTickets(req.user.id)));
router.post('/support/tickets', validate(z.object({
  subject: z.string().trim().min(3).max(200), body: z.string().trim().min(5).max(4000), channel: z.enum(['in_app', 'email']).optional(),
})), (req, res) => res.status(201).json(support.createTicket(req.user.id, req.body)));

router.get('/content/tips', (req, res) => res.json(support.tips(req.query.lang || req.user.language)));

module.exports = router;
