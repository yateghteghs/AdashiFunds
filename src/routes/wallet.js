'use strict';
const express = require('express');
const QRCode = require('qrcode');
const wallet = require('../services/wallet');
const statements = require('../services/statements');
const { provider } = require('../services/payments');
const { validate, z, kobo, id } = require('../http');
const { bad } = require('../lib/errors');

const router = express.Router();

router.get('/', (req, res) => res.json(wallet.balance(req.user.id)));

router.get('/transactions', validate(z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  type: z.string().optional(),
}), 'query'), (req, res) => res.json(wallet.history(req.user.id, req.validQuery)));

router.post('/deposits', validate(z.object({
  amount: kobo.min(100_00, 'Minimum deposit is ₦100'),
  channel: z.enum(['card', 'bank_transfer', 'ussd', 'mobile_money']).optional(),
})), async (req, res) => {
  res.status(201).json(await wallet.initDeposit(req.user.id, req.body));
});

router.get('/deposits/:reference/verify', async (req, res) => {
  res.json(await wallet.verifyDeposit(req.user.id, req.params.reference));
});

router.post('/withdrawals', validate(z.object({ amount: kobo.min(100_00), bankAccountId: id.optional() })), async (req, res) => {
  res.status(201).json(await wallet.withdraw(req.user.id, { ...req.body, deviceId: req.deviceId }));
});

router.post('/transfers', validate(z.object({
  amount: kobo, recipient: z.string().optional(), recipientId: id.optional(), note: z.string().max(140).optional(),
}).refine((b) => b.recipient || b.recipientId, 'Provide recipient (phone/email) or recipientId')), (req, res) => {
  res.status(201).json(wallet.transferToUser(req.user.id, { ...req.body, deviceId: req.deviceId }));
});

router.get('/banks', async (_req, res) => res.json(await provider().listBanks()));
router.get('/bank-accounts', (req, res) => res.json(wallet.listBankAccounts(req.user.id)));
router.post('/bank-accounts', validate(z.object({ bankCode: z.string().min(2).max(10), accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits') })), async (req, res) => {
  res.status(201).json(await wallet.addBankAccount(req.user.id, req.body));
});
router.delete('/bank-accounts/:id', (req, res) => {
  wallet.removeBankAccount(req.user.id, req.params.id);
  res.json({ ok: true });
});

// QR code other users can scan to pay this user.
router.get('/qr', validate(z.object({ amount: z.coerce.number().int().positive().optional() }), 'query'), async (req, res) => {
  const payload = wallet.paymentRequestPayload(req.user.id, req.validQuery.amount);
  res.json({ payload, dataUrl: await QRCode.toDataURL(payload, { margin: 1, width: 280 }) });
});

function rangeFrom(q) {
  if (q.month) return statements.monthRange(q.month);
  if (q.from && q.to) return { from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString() };
  throw bad('range_required', 'Provide month=YYYY-MM or from & to dates');
}

router.get('/statement', validate(z.object({
  month: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  format: z.enum(['json', 'csv', 'pdf']).optional(),
}), 'query'), async (req, res) => {
  const q = req.validQuery;
  const range = rangeFrom(q);
  const name = `adashifunds-statement-${range.from.slice(0, 10)}`;
  if (q.format === 'csv') {
    res.type('text/csv').attachment(`${name}.csv`).send(statements.toCsv(req.user.id, range));
  } else if (q.format === 'pdf') {
    res.type('application/pdf').attachment(`${name}.pdf`).send(await statements.toPdf(req.user.id, range));
  } else {
    res.json(statements.build(req.user.id, range));
  }
});

router.get('/summary', validate(z.object({ month: z.string() }), 'query'), (req, res) => {
  res.json(statements.monthlySummary(req.user.id, req.validQuery.month));
});

module.exports = router;
