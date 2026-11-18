'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, app, registerUser, fund, startedGroup, makeAdmin, db } = require('./helpers');
const request = require('supertest');
const audit = require('../src/services/audit');

test('disputes: parties and neutral admin only; evidence trail attached', async () => {
  const [admin, b, c, outsider] = [await registerUser('Dis Admin'), await registerUser('Dis B'), await registerUser('Dis C'), await registerUser('Dis X')];
  await fund(b, 10_000);
  const g = await startedGroup([admin, b, c]);
  const contrib = await api().post(`/api/groups/${g.id}/contributions`).set(b.auth).send({});
  const d = await api().post('/api/disputes').set(b.auth).send({
    groupId: g.id, againstUserId: c.id, transactionId: contrib.body.transaction.reference, category: 'member_default',
    description: 'Chidi has not paid and is ignoring messages.',
  });
  assert.equal(d.status, 201);
  assert.ok(d.body.transaction);
  assert.ok(d.body.auditTrail.length > 0, 'audit trail evidence is attached');

  assert.equal((await api().get(`/api/disputes/${d.body.id}`).set(outsider.auth)).status, 403);
  const reply = await api().post(`/api/disputes/${d.body.id}/messages`).set(c.auth).send({ body: 'I will pay on Friday.' });
  assert.equal(reply.status, 201);
  assert.equal((await api().post(`/api/disputes/${d.body.id}/status`).set(c.auth).send({ status: 'resolved', resolution: 'x' })).status, 403);
  const resolved = await api().post(`/api/disputes/${d.body.id}/status`).set(admin.auth).send({ status: 'resolved', resolution: 'Member agreed to pay Friday.' });
  assert.equal(resolved.body.status, 'resolved');
  const closed = await api().post(`/api/disputes/${d.body.id}/messages`).set(b.auth).send({ body: 'thanks' });
  assert.equal(closed.status, 409);
});

test('referrals reward the referrer on the referee\'s first contribution', async () => {
  const ref = await registerUser('Referrer Rita');
  const friend = await registerUser('Friend Femi', { referralCode: ref.user.referralCode });
  const other = await registerUser('Other Ola');
  await fund(friend, 10_000);
  const g = await startedGroup([friend, other]);
  let s = await api().get('/api/me/referrals').set(ref.auth);
  assert.equal(s.body.points, 0);
  assert.equal(s.body.referred[0].active, false);
  await api().post(`/api/groups/${g.id}/contributions`).set(friend.auth).send({});
  s = await api().get('/api/me/referrals').set(ref.auth);
  assert.equal(s.body.points, 100);
  assert.equal(s.body.referred[0].name, 'Friend F.');
  const lb = await api().get('/api/leaderboard').set(ref.auth);
  assert.equal(lb.body.referrers[0].name, 'Referrer R.');
  const badRef = await api().post('/api/auth/register').send({ fullName: 'X', phone: '08055555555', password: 'passw0rd1', referralCode: 'NOPE' });
  assert.equal(badRef.status, 400);
});

test('USSD: balance, groups and PIN-protected contribution', async () => {
  const u = await registerUser('Ussd Uche');
  const v = await registerUser('Ussd Vera');
  await fund(u, 8_000);
  const g = await startedGroup([u, v]);
  const ussd = (text) => request(app).post('/api/ussd').type('form').send({ sessionId: 's1', serviceCode: '*384#', phoneNumber: u.phone, text });

  assert.match((await ussd('')).text, /^CON AdashiFunds/);
  assert.match((await ussd('1')).text, /^END .*8,000/);
  assert.match((await ussd('2')).text, /Test Adashi/);
  assert.match((await ussd('3')).text, /Set a USSD PIN/);

  await api().post('/api/me/ussd-pin').set(u.auth).send({ password: 'passw0rd1', pin: '2468' });
  assert.match((await ussd('3')).text, /^CON Choose a group/);
  assert.match((await ussd('3*1')).text, /Enter your 4-digit PIN/);
  assert.match((await ussd('3*1*0000')).text, /Incorrect PIN/);
  assert.match((await ussd('3*1*2468')).text, /^END Paid/);
  const c = db.get("SELECT status FROM contributions WHERE group_id = ? AND user_id = ?", g.id, u.id);
  assert.equal(c.status, 'paid');
  assert.match((await ussd('4')).text, /Next payout/);
  const unknown = await request(app).post('/api/ussd').type('form').send({ phoneNumber: '+2348000000000', text: '' });
  assert.match(unknown.text, /not registered/);
});

test('localised notifications', async () => {
  const u = await registerUser('Pidgin Paul');
  await api().patch('/api/me').set(u.auth).send({ language: 'pcm' });
  const sender = await registerUser('Sender Sola');
  await fund(sender, 1_000);
  await api().post('/api/wallet/transfers').set(sender.auth).send({ recipientId: u.id, amount: 500_00 });
  const n = await api().get('/api/notifications').set(u.auth);
  assert.match(n.body.items[0].body, /You don receive/);
  await api().post('/api/notifications/read').set(u.auth).send({});
  assert.equal((await api().get('/api/notifications').set(u.auth)).body.unread, 0);
});

test('support assistant answers FAQs and falls back to tickets', async () => {
  const u = await registerUser('Curious Cee');
  const a = await api().post('/api/support/assistant').set(u.auth).send({ question: 'What happens if I pay late?' });
  assert.equal(a.body.confident, true);
  assert.match(a.body.answer, /penalty/);
  const b = await api().post('/api/support/assistant').set(u.auth).send({ question: 'Can I pay in bitcoin on the moon?' });
  assert.equal(b.body.confident, false);
  const t = await api().post('/api/support/tickets').set(u.auth).send({ subject: 'Help', body: 'I need help with my group' });
  assert.equal(t.status, 201);
  const tips = await api().get('/api/content/tips').set(u.auth);
  assert.ok(tips.body.length >= 3);
});

test('admin: stats, KYC review, fraud review, suspension, ledger reconcile', async () => {
  const admin = await makeAdmin(await registerUser('Platform Admin'));
  const s = await api().get('/api/admin/stats').set(admin.auth);
  assert.equal(s.status, 200);
  assert.ok(s.body.users >= 1);
  assert.equal((await api().get('/api/admin/ledger/reconcile').set(admin.auth)).body.ok, true);

  // Manual KYC queue
  const config = require('../src/config');
  config.kycProvider = 'manual';
  const u = await registerUser('Manual Kyc');
  const sub = await api().post('/api/me/kyc').set(u.auth).send({ idType: 'PASSPORT', idNumber: 'A12345678' });
  config.kycProvider = 'mock';
  assert.equal(sub.body.status, 'pending');
  const pending = await api().get('/api/admin/kyc/pending').set(admin.auth);
  assert.ok(pending.body.some((p) => p.id === sub.body.id));
  await api().post(`/api/admin/kyc/${sub.body.id}/review`).set(admin.auth).send({ status: 'verified' });
  assert.equal((await api().get('/api/me').set(u.auth)).body.user.kycStatus, 'verified');

  const sus = await api().post(`/api/admin/users/${u.id}/status`).set(admin.auth).send({ status: 'suspended' });
  assert.equal(sus.status, 200);
  assert.equal((await api().get('/api/me').set(u.auth)).status, 403);
});

test('audit log is hash-chained and detects tampering', async () => {
  const admin = await makeAdmin(await registerUser('Auditor'));
  let v = await api().get('/api/admin/audit/verify').set(admin.auth);
  assert.equal(v.body.valid, true);
  assert.ok(v.body.checked > 5);
  const victim = db.get('SELECT seq FROM audit_log ORDER BY seq LIMIT 1 OFFSET 3');
  db.run("UPDATE audit_log SET data = '{\"amount\":1}' WHERE seq = ?", victim.seq);
  v = await api().get('/api/admin/audit/verify').set(admin.auth);
  assert.equal(v.body.valid, false);
  assert.equal(v.body.brokenAtSeq, victim.seq);
  assert.equal(audit.verify().valid, false);
});

test('payment webhook signature is enforced for Paystack', async () => {
  const config = require('../src/config');
  config.paystackSecretKey = 'sk_test_dummy';
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'nope', amount: 100 } });
  const bad = await request(app).post('/api/webhooks/paystack').set('content-type', 'application/json').set('x-paystack-signature', 'bad').send(body);
  assert.equal(bad.status, 401);
  const sig = require('node:crypto').createHmac('sha512', 'sk_test_dummy').update(body).digest('hex');
  const ok = await request(app).post('/api/webhooks/paystack').set('content-type', 'application/json').set('x-paystack-signature', sig).send(body);
  assert.equal(ok.status, 200);
});

test('meta and health endpoints', async () => {
  const m = await api().get('/api/meta');
  assert.deepEqual(m.body.languages, ['en', 'ha', 'yo', 'ig', 'pcm', 'fr']);
  assert.equal((await api().get('/api/health')).body.ok, true);
  assert.equal((await api().get('/')).status, 200);
});
