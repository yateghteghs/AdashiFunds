'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, fund, verifyKyc, balance, db } = require('./helpers');
const ledger = require('../src/services/ledger');

test('deposits credit the wallet and are idempotent', async () => {
  const u = await registerUser('Depositor');
  const d = await fund(u, 2_000);
  assert.equal(d.status, 'success');
  assert.equal(await balance(u), 2_000_00);
  require('../src/services/wallet').settleDeposit(d.reference, 2_000_00); // replayed webhook
  assert.equal(await balance(u), 2_000_00);
  const tooSmall = await api().post('/api/wallet/deposits').set(u.auth).send({ amount: 50_00 });
  assert.equal(tooSmall.status, 400);
});

test('peer-to-peer transfer by phone, with insufficient funds guard', async () => {
  const a = await registerUser('Sender');
  const b = await registerUser('Receiver');
  await fund(a, 1_000);
  const t = await api().post('/api/wallet/transfers').set(a.auth).send({ recipient: b.phone, amount: 400_00, note: 'Lunch' });
  assert.equal(t.status, 201);
  assert.equal(await balance(a), 600_00);
  assert.equal(await balance(b), 400_00);
  const over = await api().post('/api/wallet/transfers').set(a.auth).send({ recipient: b.phone, amount: 10_000_00 });
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, 'insufficient_funds');
  const self = await api().post('/api/wallet/transfers').set(a.auth).send({ recipientId: a.id, amount: 100 });
  assert.equal(self.status, 400);
  const notifs = await api().get('/api/notifications').set(b.auth);
  assert.ok(notifs.body.items.some((n) => n.type === 'transfer_received'));
  const hist = await api().get('/api/wallet/transactions').set(b.auth);
  assert.equal(hist.body[0].net, 400_00);
});

test('withdrawals require KYC and a bank account, and respect tier limits', async () => {
  const u = await registerUser('Withdrawer');
  await fund(u, 300_000);
  const noKyc = await api().post('/api/wallet/withdrawals').set(u.auth).send({ amount: 1_000_00 });
  assert.equal(noKyc.status, 400); // no bank account yet
  const banks = await api().get('/api/wallet/banks').set(u.auth);
  const acct = await api().post('/api/wallet/bank-accounts').set(u.auth).send({ bankCode: banks.body[0].code, accountNumber: '0123456789' });
  assert.equal(acct.status, 201);
  assert.equal(acct.body.accountLast4, '6789');
  const blocked = await api().post('/api/wallet/withdrawals').set(u.auth).send({ amount: 1_000_00 });
  assert.equal(blocked.status, 403);

  await verifyKyc(u);
  const overLimit = await api().post('/api/wallet/withdrawals').set(u.auth).send({ amount: 250_000_00 });
  assert.equal(overLimit.body.error.code, 'limit_exceeded');
  const w = await api().post('/api/wallet/withdrawals').set(u.auth).send({ amount: 1_000_00 });
  assert.equal(w.status, 201);
  assert.equal(w.body.status, 'success');
  assert.equal(await balance(u), 299_000_00);
});

test('failed bank transfer is reversed back to the wallet', async () => {
  const u = await registerUser('Unlucky');
  await fund(u, 10_000);
  await verifyKyc(u);
  await api().post('/api/wallet/bank-accounts').set(u.auth).send({ bankCode: '058', accountNumber: '0123456780' });
  const mock = require('../src/services/payments/mock');
  const original = mock.transfer;
  mock.transfer = async () => { throw new Error('bank unavailable'); };
  try {
    const w = await api().post('/api/wallet/withdrawals').set(u.auth).send({ amount: 5_000_00 });
    assert.equal(w.status, 502);
  } finally {
    mock.transfer = original;
  }
  assert.equal(await balance(u), 10_000_00);
  const t = db.get("SELECT status FROM transactions WHERE user_id = ? AND type = 'withdrawal'", u.id);
  assert.equal(t.status, 'reversed');
});

test('statements: JSON, CSV and PDF', async () => {
  const u = await registerUser('Statement Sade');
  await fund(u, 1_500);
  const month = new Date().toISOString().slice(0, 7);
  const json = await api().get(`/api/wallet/statement?month=${month}`).set(u.auth);
  assert.equal(json.body.closingBalance, 1_500_00);
  const csv = await api().get(`/api/wallet/statement?month=${month}&format=csv`).set(u.auth);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.text, /^date,reference,type/);
  assert.match(csv.text, /deposit/);
  const pdf = await api().get(`/api/wallet/statement?month=${month}&format=pdf`).set(u.auth).buffer(true).parse((res, cb) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
  const summary = await api().get(`/api/wallet/summary?month=${month}`).set(u.auth);
  assert.equal(summary.body.deposits, 1_500_00);
});

test('QR payment payload identifies the payee', async () => {
  const u = await registerUser('Qr Queen');
  const r = await api().get('/api/wallet/qr?amount=50000').set(u.auth);
  assert.match(r.body.payload, new RegExp(`to=${u.id}`));
  assert.match(r.body.dataUrl, /^data:image\/png;base64,/);
});

test('fraud engine blocks transfer bursts and flags them for review', async () => {
  const a = await registerUser('Burst Sender');
  const b = await registerUser('Burst Receiver');
  await fund(a, 5_000);
  let blocked = null;
  for (let i = 0; i < 12; i++) {
    const r = await api().post('/api/wallet/transfers').set(a.auth).send({ recipientId: b.id, amount: 100_00 });
    if (r.status === 403) { blocked = r.body; break; }
  }
  assert.ok(blocked, 'a burst of transfers should eventually be blocked');
  assert.equal(blocked.error.code, 'transaction_blocked');
  const flags = db.all('SELECT * FROM fraud_flags WHERE user_id = ?', a.id);
  assert.ok(flags.some((f) => f.rule === 'velocity' && f.action === 'blocked'));
});

test('ledger always balances', () => {
  const r = ledger.reconcile();
  assert.equal(r.ok, true, JSON.stringify(r));
});
