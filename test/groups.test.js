'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, fund, balance, startedGroup, clock, db, DAY, HOUR } = require('./helpers');
const scheduler = require('../src/services/scheduler');
const ledger = require('../src/services/ledger');

afterEach(() => clock.reset());

const detail = async (user, groupId) => (await api().get(`/api/groups/${groupId}`).set(user.auth)).body;
const pay = (user, groupId) => api().post(`/api/groups/${groupId}/contributions`).set(user.auth).send({});

test('full rotation: every member contributes each round and each receives one payout', async () => {
  const members = [await registerUser('Amina'), await registerUser('Bisi'), await registerUser('Chidi')];
  for (const m of members) await fund(m, 20_000);
  const g = await startedGroup(members, { payoutTiming: 'when_complete' });
  assert.equal(g.status, 'active');
  assert.equal(g.rounds.length, 3);
  assert.deepEqual(g.rounds.map((r) => r.recipientId), members.map((m) => m.id), 'join order decides payout order');

  for (let round = 1; round <= 3; round++) {
    for (const m of members) {
      const r = await pay(m, g.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
  }
  const final = await detail(members[0], g.id);
  assert.equal(final.status, 'completed');
  assert.ok(final.rounds.every((r) => r.status === 'paid_out' && r.payoutAmount === 15_000_00));

  // Each paid 3 x 5,000 and received 15,000 less the 0.5% platform fee (75).
  for (const m of members) assert.equal(await balance(m), 20_000_00 - 15_000_00 + 15_000_00 - 75_00);
  assert.equal(ledger.systemAccount('fees').balance >= 225_00, true);
  assert.equal(ledger.reconcile().ok, true);

  const again = await pay(members[0], g.id);
  assert.equal(again.body.error.code, 'nothing_due');
});

test('group membership rules: invite codes, capacity, KYC-only groups, leaving', async () => {
  const [a, b, c] = [await registerUser('Admin A'), await registerUser('Bola'), await registerUser('Cyril')];
  const g = await startedGroup([a, b], {}, { start: false });
  assert.equal(g.status, 'forming');
  const full = await api().post('/api/groups/join').set(c.auth).send({ inviteCode: g.inviteCode });
  assert.equal(full.body.error.code, 'group_full');
  const outsider = await api().get(`/api/groups/${g.id}`).set(c.auth);
  assert.equal(outsider.status, 403);

  const leave = await api().post(`/api/groups/${g.id}/leave`).set(b.auth);
  assert.equal(leave.status, 200);
  const tooFew = await api().post(`/api/groups/${g.id}/start`).set(a.auth).send({});
  assert.equal(tooFew.body.error.code, 'not_enough_members');

  const kycGroup = await api().post('/api/groups').set(a.auth).send({ name: 'KYC only', contributionAmount: 1_000_00, frequency: 'daily', maxMembers: 5, requireKyc: true });
  assert.equal(kycGroup.status, 403, 'admin must be verified to create a KYC-only group');
  const pub = await api().post('/api/groups').set(a.auth).send({ name: 'Open circle', contributionAmount: 1_000_00, frequency: 'daily', maxMembers: 5, isPublic: true });
  const listed = await api().get('/api/groups/public').set(c.auth);
  assert.ok(listed.body.some((x) => x.id === pub.body.id));
  const joinPublic = await api().post('/api/groups/join').set(c.auth).send({ groupId: pub.body.id });
  assert.equal(joinPublic.status, 200);
});

test('manual payout order is respected', async () => {
  const [a, b, c] = [await registerUser('Ord A'), await registerUser('Ord B'), await registerUser('Ord C')];
  const g = await startedGroup([a, b, c], {}, { start: false });
  const order = [c.id, a.id, b.id];
  const set = await api().put(`/api/groups/${g.id}/payout-order`).set(a.auth).send({ userIds: order });
  assert.equal(set.status, 200);
  const notAdmin = await api().put(`/api/groups/${g.id}/payout-order`).set(b.auth).send({ userIds: order });
  assert.equal(notAdmin.status, 403);
  const s = await api().post(`/api/groups/${g.id}/start`).set(a.auth).send({});
  assert.deepEqual(s.body.rounds.map((r) => r.recipientId), order);
});

test('scheduler: reminders, auto-debit on due date, late penalty, default and later recovery', async () => {
  const [a, b, c] = [await registerUser('Sched A'), await registerUser('Sched B'), await registerUser('Sched C')];
  await fund(a, 50_000);
  await fund(b, 50_000);
  await fund(c, 1_000); // cannot cover the 5,000 contribution
  const g = await startedGroup([a, b, c], { latePenaltyBps: 1000, gracePeriodHours: 24 });
  db.run('UPDATE group_members SET auto_debit = 0 WHERE group_id = ? AND user_id = ?', g.id, b.id); // B pays manually
  const due = new Date(g.rounds[0].dueAt).getTime();

  // A day before the due date: reminders go out, nothing is debited yet.
  clock.advance(due - Date.now() - 12 * HOUR);
  scheduler.runDueJobs();
  let n = await api().get('/api/notifications').set(b.auth);
  assert.ok(n.body.items.some((x) => x.type === 'contribution_due'));
  assert.equal(await balance(a), 50_000_00);

  // Due date: auto-debit takes A's contribution; C's auto-debit fails (insufficient funds).
  clock.advance(13 * HOUR);
  scheduler.runDueJobs();
  assert.equal(await balance(a), 45_000_00);
  n = await api().get('/api/notifications').set(c.auth);
  assert.ok(n.body.items.some((x) => x.type === 'auto_debit_failed'));

  // During grace period B pays without penalty.
  clock.advance(2 * HOUR);
  let r = await pay(b, g.id);
  assert.equal(r.body.penalty, 0);

  // Grace period ends: round settles. A gets the 10,000 collected; C is recorded as a default.
  clock.advance(24 * HOUR);
  scheduler.runDueJobs();
  let d = await detail(a, g.id);
  assert.equal(d.rounds[0].status, 'paid_out');
  assert.equal(d.rounds[0].payoutAmount, 10_000_00);
  const cContribution = d.rounds[0].contributions.find((x) => x.userId === c.id);
  assert.equal(cContribution.status, 'defaulted');
  assert.equal(cContribution.penaltyIfPaidNow, 500_00);
  assert.equal(d.rounds[1].status, 'open', 'next round opens');
  const trustBefore = (await api().get('/api/me/trust-score').set(c.auth)).body.score;

  // C tops up and settles: 5,000 goes straight to A (round 1 recipient), 500 penalty to the reserve.
  await fund(c, 10_000);
  const aBefore = await balance(a);
  r = await pay(c, g.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.penalty, 500_00);
  assert.equal(await balance(a), aBefore + 5_000_00);
  d = await detail(a, g.id);
  assert.equal(d.reserveBalance, 500_00);
  const trustAfter = (await api().get('/api/me/trust-score').set(c.auth)).body;
  assert.ok(trustAfter.score > trustBefore, 'settling a default improves the score');
  assert.equal(trustAfter.stats.recoveredDefaults, 1);
  assert.equal(ledger.reconcile().ok, true);
});

test('on_due_date payout timing waits for the due date', async () => {
  const [a, b] = [await registerUser('Due A'), await registerUser('Due B')];
  await fund(a, 20_000);
  await fund(b, 20_000);
  const g = await startedGroup([a, b], { payoutTiming: 'on_due_date', frequency: 'daily' });
  await pay(a, g.id);
  await pay(b, g.id);
  let d = await detail(a, g.id);
  assert.equal(d.rounds[0].status, 'open');
  assert.equal(d.potBalance, 10_000_00);
  clock.advance(new Date(g.rounds[0].dueAt).getTime() - Date.now() + 1000);
  scheduler.runDueJobs();
  d = await detail(a, g.id);
  assert.equal(d.rounds[0].status, 'paid_out');
  assert.equal(d.potBalance, 0);
});

test('governance: settings locked after start, rule changes pass by majority vote', async () => {
  const members = [await registerUser('Gov A'), await registerUser('Gov B'), await registerUser('Gov C')];
  const g = await startedGroup(members);
  const direct = await api().patch(`/api/groups/${g.id}`).set(members[0].auth).send({ latePenaltyBps: 2000 });
  assert.equal(direct.body.error.code, 'vote_required');

  const p = await api().post(`/api/groups/${g.id}/proposals`).set(members[1].auth)
    .send({ type: 'rule_change', title: 'Raise late penalty to 20%', payload: { changes: { latePenaltyBps: 2000 } } });
  assert.equal(p.status, 201);
  assert.equal(p.body.tally.yes, 1);
  assert.equal(p.body.status, 'open');
  const dupe = await api().post(`/api/proposals/${p.body.id}/votes`).set(members[1].auth).send({ choice: 'yes' });
  assert.equal(dupe.body.error.code, 'already_voted');
  const v = await api().post(`/api/proposals/${p.body.id}/votes`).set(members[2].auth).send({ choice: 'yes' });
  assert.equal(v.body.status, 'passed');
  assert.equal((await detail(members[0], g.id)).latePenaltyBps, 2000);

  // Rejected as soon as passing is impossible.
  const p2 = await api().post(`/api/groups/${g.id}/proposals`).set(members[0].auth)
    .send({ type: 'rule_change', title: 'Zero penalty', payload: { changes: { latePenaltyBps: 0 } } });
  await api().post(`/api/proposals/${p2.body.id}/votes`).set(members[1].auth).send({ choice: 'no' });
  const v2 = await api().post(`/api/proposals/${p2.body.id}/votes`).set(members[2].auth).send({ choice: 'no' });
  assert.equal(v2.body.status, 'rejected');

  // Locked structural settings cannot be changed even by vote.
  const p3 = await api().post(`/api/groups/${g.id}/proposals`).set(members[0].auth)
    .send({ type: 'rule_change', title: 'Go monthly', payload: { changes: { frequency: 'monthly' } } });
  const v3 = await api().post(`/api/proposals/${p3.body.id}/votes`).set(members[1].auth).send({ choice: 'yes' });
  assert.equal(v3.body.status, 'passed');
  assert.equal((await detail(members[0], g.id)).frequency, 'weekly');

  // Unresolved proposals expire.
  const p4 = await api().post(`/api/groups/${g.id}/proposals`).set(members[0].auth)
    .send({ type: 'rule_change', title: 'Longer grace', payload: { changes: { gracePeriodHours: 48 } } });
  clock.advance(73 * HOUR);
  scheduler.runDueJobs();
  assert.equal((await api().get(`/api/proposals/${p4.body.id}`).set(members[0].auth)).body.status, 'expired');
});

test('emergency loans: vote, disbursement from reserve, repayment, and recovery from payout', async () => {
  const [a, b, c] = [await registerUser('Loan A'), await registerUser('Loan B'), await registerUser('Loan C')];
  for (const m of [a, b, c]) await fund(m, 50_000);
  const g = await startedGroup([a, b, c], { loanInterestBps: 1000 });
  await api().post(`/api/groups/${g.id}/reserve`).set(a.auth).send({ amount: 20_000_00 });

  const noKyc = await api().post(`/api/groups/${g.id}/loans`).set(c.auth).send({ amount: 5_000_00 });
  assert.equal(noKyc.status, 403);
  await api().post('/api/me/kyc').set(c.auth).send({ idType: 'NIN', idNumber: '12345678901' });
  const tooBig = await api().post(`/api/groups/${g.id}/loans`).set(c.auth).send({ amount: 50_000_00 });
  assert.equal(tooBig.body.error.code, 'insufficient_reserve');

  const loan = await api().post(`/api/groups/${g.id}/loans`).set(c.auth).send({ amount: 10_000_00, termDays: 14, reason: 'Hospital bill' });
  assert.equal(loan.status, 201);
  assert.equal(loan.body.status, 'pending_vote');
  assert.equal(loan.body.totalDue, 11_000_00);
  const selfVote = await api().post(`/api/proposals/${loan.body.proposalId}/votes`).set(c.auth).send({ choice: 'yes' });
  assert.equal(selfVote.status, 403, 'borrower cannot vote on own loan');
  // Two eligible voters (borrower excluded): a strict majority needs both.
  const v1 = await api().post(`/api/proposals/${loan.body.proposalId}/votes`).set(a.auth).send({ choice: 'yes' });
  assert.equal(v1.body.status, 'open');
  assert.equal(v1.body.tally.needed, 2);
  const v = await api().post(`/api/proposals/${loan.body.proposalId}/votes`).set(b.auth).send({ choice: 'yes' });
  assert.equal(v.body.status, 'passed');
  assert.equal(await balance(c), 60_000_00);

  // Partial repayment from wallet.
  const rep = await api().post(`/api/loans/${loan.body.id}/repayments`).set(c.auth).send({ amount: 3_000_00 });
  assert.equal(rep.body.outstanding, 8_000_00);

  // Round 3 pays C; the remaining 8,000 is recovered from that payout before it reaches C's wallet.
  for (let round = 1; round <= 3; round++) for (const m of [a, b, c]) await pay(m, g.id);
  const loans = await api().get('/api/me/loans').set(c.auth);
  assert.equal(loans.body[0].status, 'repaid');
  const payout = db.get("SELECT * FROM transactions WHERE type = 'payout' AND user_id = ?", c.id);
  assert.equal(JSON.parse(payout.metadata).loanRecovered, 8_000_00);
  // Reserve: 20,000 - 10,000 + 3,000 + 8,000 = 21,000 (interest earned for the group).
  assert.equal((await detail(a, g.id)).reserveBalance, 21_000_00);
  assert.equal(ledger.reconcile().ok, true);
});

test('group chat is members-only and includes system events', async () => {
  const [a, b, x] = [await registerUser('Chat A'), await registerUser('Chat B'), await registerUser('Outsider')];
  const g = await startedGroup([a, b]);
  const post = await api().post(`/api/groups/${g.id}/messages`).set(b.auth).send({ body: 'I will pay tomorrow morning' });
  assert.equal(post.status, 201);
  const list = await api().get(`/api/groups/${g.id}/messages`).set(a.auth);
  assert.ok(list.body.some((m) => m.body.includes('pay tomorrow')));
  assert.ok(list.body.some((m) => m.user_id === null && m.body.includes('started')));
  assert.equal((await api().get(`/api/groups/${g.id}/messages`).set(x.auth)).status, 403);
});

test('dashboard summarises wallet, dues and next payout', async () => {
  const [a, b] = [await registerUser('Dash A'), await registerUser('Dash B')];
  await fund(a, 10_000);
  const g = await startedGroup([a, b]);
  const d = await api().get('/api/me/dashboard').set(b.auth);
  assert.equal(d.status, 200);
  assert.equal(d.body.contributionsDue[0].groupId, g.id);
  assert.equal(d.body.nextPayout.groupId, g.id);
  assert.equal(d.body.nextPayout.amount, 10_000_00);
});
