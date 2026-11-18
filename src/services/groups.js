'use strict';
// Adashi group engine: membership, rotation schedule, contributions, penalties and payouts.
//
// Lifecycle
//   forming   -> members join via invite code; admin may edit settings directly.
//   active    -> one round per member. Round k collects one contribution from every active member
//                and pays the pot to the member at payout position k. Rule changes now need a vote.
//   completed -> every member has received a payout.
//
// Rules enforced by the engine (the "smart contract"):
//   * Contributions are debited from wallets; auto-debit runs on the due date.
//   * Paying after due date + grace period adds a late penalty (to the group reserve).
//   * At due date + grace the round is settled: unpaid contributions become defaults and the
//     collected pot is paid out. A defaulter's later payment goes straight to that round's recipient.
//   * Outstanding group loans are recovered from the borrower's payout before it reaches their wallet.
const db = require('../db');
const clock = require('../lib/clock');
const config = require('../config');
const { uid, randomCode } = require('../lib/crypto');
const { bad, forbidden, notFound, conflict } = require('../lib/errors');
const money = require('../lib/money');
const ledger = require('./ledger');
const audit = require('./audit');
const { notify } = require('./notifications');

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
// Settings the admin may change freely while forming, and which need a vote once active.
const EDITABLE = {
  name: 'name', description: 'description', contributionAmount: 'contribution_amount', maxMembers: 'max_members',
  latePenaltyBps: 'late_penalty_bps', gracePeriodHours: 'grace_period_hours', loanInterestBps: 'loan_interest_bps',
  approvalThresholdBps: 'approval_threshold_bps', payoutTiming: 'payout_timing', isPublic: 'is_public',
  requireKyc: 'require_kyc', payoutOrder: 'payout_order', frequency: 'frequency',
};
// Settings that cannot change once the schedule exists.
const LOCKED_WHEN_ACTIVE = ['max_members', 'payout_order', 'frequency'];

function addPeriod(date, frequency, n = 1) {
  const d = new Date(date);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + n);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

const graceEnd = (round, group) => new Date(new Date(round.due_at).getTime() + group.grace_period_hours * 3_600_000);

function getGroupRow(groupId) {
  const g = db.get('SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) throw notFound('Group');
  return g;
}

function membership(groupId, userId) {
  return db.get("SELECT * FROM group_members WHERE group_id = ? AND user_id = ? AND status = 'active'", groupId, userId);
}

function requireMember(groupId, userId) {
  const m = membership(groupId, userId);
  if (!m) throw forbidden('You are not a member of this group');
  return m;
}

function requireAdmin(groupId, userId) {
  const m = requireMember(groupId, userId);
  if (m.role !== 'admin') throw forbidden('Only the group admin can do this');
  return m;
}

const activeMembers = (groupId) =>
  db.all(`SELECT gm.*, u.full_name, u.phone FROM group_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ? AND gm.status = 'active' ORDER BY COALESCE(gm.payout_position, 9999), gm.joined_at`, groupId);

function systemMessage(groupId, body) {
  db.insert('group_messages', { id: uid(), group_id: groupId, user_id: null, body, created_at: clock.iso() });
}

function uniqueInviteCode() {
  for (;;) {
    const code = randomCode(6);
    if (!db.get('SELECT 1 FROM groups WHERE invite_code = ?', code)) return code;
  }
}

function validateSettings(s) {
  if (s.frequency !== undefined && !FREQUENCIES.includes(s.frequency)) throw bad('invalid_frequency', 'Frequency must be daily, weekly or monthly');
  if (s.contribution_amount !== undefined && (!Number.isInteger(s.contribution_amount) || s.contribution_amount < 100_00)) {
    throw bad('invalid_amount', 'Contribution must be at least ₦100');
  }
  if (s.max_members !== undefined && (s.max_members < 2 || s.max_members > 100)) throw bad('invalid_size', 'Groups must have 2 to 100 members');
  if (s.late_penalty_bps !== undefined && (s.late_penalty_bps < 0 || s.late_penalty_bps > 5000)) throw bad('invalid_penalty', 'Late penalty must be between 0% and 50%');
  if (s.loan_interest_bps !== undefined && (s.loan_interest_bps < 0 || s.loan_interest_bps > 3000)) throw bad('invalid_interest', 'Loan interest must be between 0% and 30%');
  if (s.approval_threshold_bps !== undefined && (s.approval_threshold_bps < 5001 || s.approval_threshold_bps > 10000)) {
    throw bad('invalid_threshold', 'Approval threshold must be a majority (50.01%) up to 100%');
  }
  if (s.grace_period_hours !== undefined && (s.grace_period_hours < 0 || s.grace_period_hours > 24 * 14)) throw bad('invalid_grace', 'Grace period must be 0 to 336 hours');
  if (s.payout_order !== undefined && !['join_order', 'random', 'manual'].includes(s.payout_order)) throw bad('invalid_order', 'Invalid payout order');
  if (s.payout_timing !== undefined && !['when_complete', 'on_due_date'].includes(s.payout_timing)) throw bad('invalid_timing', 'Invalid payout timing');
}

function toColumns(input) {
  const out = {};
  for (const [k, col] of Object.entries(EDITABLE)) {
    if (input[k] !== undefined) out[col] = typeof input[k] === 'boolean' ? (input[k] ? 1 : 0) : input[k];
  }
  return out;
}

// --- Creation & membership ---
function createGroup(adminId, input) {
  const admin = db.get('SELECT * FROM users WHERE id = ?', adminId);
  const settings = toColumns(input);
  validateSettings(settings);
  const id = uid();
  return db.tx(() => {
    const pot = ledger.ensureAccount('group_pot', id);
    const reserve = ledger.ensureAccount('group_reserve', id);
    const group = {
      id, name: input.name, description: input.description || null, admin_id: adminId,
      contribution_amount: input.contributionAmount, frequency: input.frequency, max_members: input.maxMembers,
      payout_order: input.payoutOrder || 'join_order', late_penalty_bps: input.latePenaltyBps ?? 500,
      grace_period_hours: input.gracePeriodHours ?? 24, loan_interest_bps: input.loanInterestBps ?? 500,
      approval_threshold_bps: input.approvalThresholdBps ?? 5001, payout_timing: input.payoutTiming || 'when_complete',
      is_public: input.isPublic ? 1 : 0, require_kyc: input.requireKyc ? 1 : 0, invite_code: uniqueInviteCode(),
      status: 'forming', current_round: 0, start_at: null, pot_account_id: pot.id, reserve_account_id: reserve.id,
      created_at: clock.iso(),
    };
    if (group.require_kyc && admin.kyc_status !== 'verified') throw forbidden('Verify your identity before creating a KYC-only group');
    db.insert('groups', group);
    db.insert('group_members', {
      id: uid(), group_id: id, user_id: adminId, role: 'admin', payout_position: null, auto_debit: 1, status: 'active', joined_at: clock.iso(),
    });
    systemMessage(id, `${admin.full_name} created the group.`);
    audit.record('group.created', { actorId: adminId, entityType: 'group', entityId: id, data: settings });
    return group;
  });
}

function joinGroup(userId, { inviteCode, groupId }) {
  const group = inviteCode
    ? db.get('SELECT * FROM groups WHERE invite_code = ?', String(inviteCode).toUpperCase())
    : db.get('SELECT * FROM groups WHERE id = ? AND is_public = 1', groupId);
  if (!group) throw notFound('Group');
  if (group.status !== 'forming') throw conflict('group_not_open', 'This group has already started');
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (group.require_kyc && user.kyc_status !== 'verified') throw forbidden('This group requires identity verification (KYC)');
  const existing = db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', group.id, userId);
  if (existing && existing.status === 'active') throw conflict('already_member', 'You are already in this group');
  if (existing && existing.status === 'removed') throw forbidden('You were removed from this group');
  const count = db.get("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND status = 'active'", group.id).n;
  if (count >= group.max_members) throw conflict('group_full', 'This group is full');

  db.tx(() => {
    if (existing) db.update('group_members', existing.id, { status: 'active', joined_at: clock.iso(), role: 'member' });
    else {
      db.insert('group_members', {
        id: uid(), group_id: group.id, user_id: userId, role: 'member', payout_position: null, auto_debit: 1, status: 'active', joined_at: clock.iso(),
      });
    }
    systemMessage(group.id, `${user.full_name} joined the group.`);
  });
  notify(group.admin_id, 'member_joined', 'member_joined', { member: user.full_name, group: group.name }, { data: { groupId: group.id } });
  audit.record('group.joined', { actorId: userId, entityType: 'group', entityId: group.id });
  return group;
}

function leaveGroup(userId, groupId) {
  const group = getGroupRow(groupId);
  const m = requireMember(groupId, userId);
  if (group.status !== 'forming') throw conflict('group_active', 'You cannot leave a group once it has started. Raise a dispute if there is a problem.');
  if (m.role === 'admin') throw bad('admin_cannot_leave', 'Transfer admin rights or cancel the group instead');
  db.update('group_members', m.id, { status: 'left' });
  systemMessage(groupId, 'A member left the group.');
  audit.record('group.left', { actorId: userId, entityType: 'group', entityId: groupId });
}

function removeMember(groupId, targetUserId, actorId = null) {
  const group = getGroupRow(groupId);
  if (group.status !== 'forming') throw conflict('group_active', 'Members can only be removed before the group starts');
  const m = membership(groupId, targetUserId);
  if (!m) throw notFound('Member');
  if (m.role === 'admin') throw bad('cannot_remove_admin', 'The admin cannot be removed');
  db.update('group_members', m.id, { status: 'removed' });
  systemMessage(groupId, 'A member was removed from the group.');
  audit.record('group.member_removed', { actorId, entityType: 'group', entityId: groupId, data: { userId: targetUserId } });
}

function cancelGroup(adminId, groupId) {
  const group = getGroupRow(groupId);
  requireAdmin(groupId, adminId);
  if (group.status !== 'forming') throw conflict('group_active', 'Only groups that have not started can be cancelled');
  db.update('groups', groupId, { status: 'cancelled' });
  audit.record('group.cancelled', { actorId: adminId, entityType: 'group', entityId: groupId });
}

function updateSettings(adminId, groupId, input) {
  const group = getGroupRow(groupId);
  requireAdmin(groupId, adminId);
  if (group.status !== 'forming') throw conflict('vote_required', 'Once a group is active, rule changes must be proposed and voted on');
  const fields = toColumns(input);
  validateSettings(fields);
  if (fields.max_members !== undefined) {
    const n = db.get("SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND status = 'active'", groupId).n;
    if (fields.max_members < n) throw bad('invalid_size', 'Group already has more members than that');
  }
  db.update('groups', groupId, fields);
  audit.record('group.settings_updated', { actorId: adminId, entityType: 'group', entityId: groupId, data: fields });
  return getGroupRow(groupId);
}

// Applied by a passed governance vote.
function applyRuleChange(groupId, changes, actorId) {
  const group = getGroupRow(groupId);
  const fields = toColumns(changes);
  validateSettings(fields);
  if (group.status !== 'forming' && Object.keys(fields).some((c) => LOCKED_WHEN_ACTIVE.includes(c))) {
    throw bad('locked_setting', 'That setting cannot change after the group starts');
  }
  db.update('groups', groupId, fields);
  systemMessage(groupId, `Group rules updated by vote: ${Object.keys(changes).join(', ')}.`);
  audit.record('group.rules_changed', { actorId, entityType: 'group', entityId: groupId, data: fields });
}

function setPayoutOrder(adminId, groupId, userIds) {
  const group = getGroupRow(groupId);
  requireAdmin(groupId, adminId);
  if (group.status !== 'forming') throw conflict('group_active', 'Payout order is fixed once the group starts');
  const members = activeMembers(groupId);
  const ids = new Set(members.map((m) => m.user_id));
  if (userIds.length !== members.length || !userIds.every((id) => ids.has(id)) || new Set(userIds).size !== userIds.length) {
    throw bad('invalid_order', 'Order must list every member exactly once');
  }
  db.tx(() => {
    db.update('groups', groupId, { payout_order: 'manual' });
    userIds.forEach((id, i) => db.run('UPDATE group_members SET payout_position = ? WHERE group_id = ? AND user_id = ?', i + 1, groupId, id));
  });
  audit.record('group.payout_order_set', { actorId: adminId, entityType: 'group', entityId: groupId, data: { userIds } });
}

function setAutoDebit(userId, groupId, enabled) {
  const m = requireMember(groupId, userId);
  db.update('group_members', m.id, { auto_debit: enabled ? 1 : 0 });
}

// --- Starting & rounds ---
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = require('node:crypto').randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGroup(adminId, groupId, { firstDueAt } = {}) {
  const group = getGroupRow(groupId);
  requireAdmin(groupId, adminId);
  if (group.status !== 'forming') throw conflict('already_started', 'This group has already started');
  let members = activeMembers(groupId);
  if (members.length < 2) throw bad('not_enough_members', 'A group needs at least 2 members to start');

  if (group.payout_order === 'random') members = shuffle(members);
  else if (group.payout_order === 'join_order') members = [...members].sort((a, b) => a.joined_at.localeCompare(b.joined_at));
  else if (members.some((m) => !m.payout_position)) throw bad('order_incomplete', 'Set the payout order for every member first');

  const firstDue = firstDueAt ? new Date(firstDueAt) : addPeriod(clock.now(), group.frequency);
  if (firstDue <= clock.now()) throw bad('invalid_date', 'The first due date must be in the future');

  db.tx(() => {
    members.forEach((m, i) => {
      db.update('group_members', m.id, { payout_position: i + 1 });
      db.insert('rounds', {
        id: uid(), group_id: groupId, round_number: i + 1, recipient_id: m.user_id,
        due_at: addPeriod(firstDue, group.frequency, i).toISOString(), status: 'scheduled', reminder_sent: 0,
        payout_amount: null, payout_transaction_id: null, paid_out_at: null,
      });
    });
    db.update('groups', groupId, { status: 'active', start_at: clock.iso(), current_round: 1 });
    openRound(groupId, 1);
    systemMessage(groupId, `The group has started with ${members.length} members. Round 1 is due ${firstDue.toDateString()}.`);
  });
  members.forEach((m, i) => notify(m.user_id, 'group_started', 'group_started', { group: group.name, position: i + 1 }, { data: { groupId } }));
  audit.record('group.started', { actorId: adminId, entityType: 'group', entityId: groupId, data: { order: members.map((m) => m.user_id) } });
  return getGroupDetail(groupId, adminId);
}

function openRound(groupId, roundNumber) {
  const group = getGroupRow(groupId);
  const round = db.get('SELECT * FROM rounds WHERE group_id = ? AND round_number = ?', groupId, roundNumber);
  if (!round || round.status !== 'scheduled') return;
  db.tx(() => {
    db.update('rounds', round.id, { status: 'open' });
    for (const m of activeMembers(groupId)) {
      db.insert('contributions', {
        id: uid(), round_id: round.id, group_id: groupId, user_id: m.user_id, amount: group.contribution_amount,
        penalty: 0, status: 'pending', paid_on_time: null, paid_at: null, transaction_id: null,
        defaulted_at: null, auto_debit_attempted_at: null, late_notified: 0,
      });
    }
    db.update('groups', groupId, { current_round: roundNumber });
  });
}

// --- Contributions ---
function penaltyFor(contribution, round, group, now = clock.now()) {
  if (contribution.status === 'paid') return 0;
  return now > graceEnd(round, group) ? money.bps(contribution.amount, group.late_penalty_bps) : 0;
}

// Pay a specific contribution (or the member's oldest outstanding one in the group).
function contribute(userId, groupId, { contributionId, source = 'manual' } = {}) {
  const group = getGroupRow(groupId);
  requireMember(groupId, userId);
  const c = contributionId
    ? db.get('SELECT * FROM contributions WHERE id = ? AND user_id = ? AND group_id = ?', contributionId, userId, groupId)
    : db.get(`SELECT c.* FROM contributions c JOIN rounds r ON r.id = c.round_id
              WHERE c.user_id = ? AND c.group_id = ? AND c.status IN ('pending','defaulted')
              ORDER BY r.round_number LIMIT 1`, userId, groupId);
  if (!c) throw bad('nothing_due', 'You have no outstanding contribution in this group');
  if (c.status === 'paid') throw conflict('already_paid', 'This contribution is already paid');

  const round = db.get('SELECT * FROM rounds WHERE id = ?', c.round_id);
  const now = clock.now();
  const penalty = penaltyFor(c, round, group, now);
  const onTime = now <= new Date(round.due_at) ? 1 : 0;
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);

  const result = db.tx(() => {
    const wallet = ledger.userAccount(userId);
    // Before payout the money goes to the pot; after (a defaulted contribution) it goes straight to the recipient.
    const destination = round.status === 'paid_out' ? ledger.userAccount(round.recipient_id).id : group.pot_account_id;
    const legs = [
      { accountId: wallet.id, amount: -(c.amount + penalty) },
      { accountId: destination, amount: c.amount },
    ];
    if (penalty) legs.push({ accountId: group.reserve_account_id, amount: penalty });
    const txn = ledger.post({
      type: 'contribution', amount: c.amount, fee: penalty, user_id: userId, group_id: groupId,
      counterparty_user_id: round.status === 'paid_out' ? round.recipient_id : null,
      description: `${group.name} – round ${round.round_number} contribution${penalty ? ' (incl. late penalty)' : ''}`,
      metadata: { roundNumber: round.round_number, contributionId: c.id, penalty, source },
    }, legs);
    db.update('contributions', c.id, { status: 'paid', penalty, paid_on_time: onTime, paid_at: clock.iso(), transaction_id: txn.id });
    return txn;
  });

  notify(userId, 'contribution_received', 'contribution_received', { amount: money.format(c.amount), group: group.name }, { data: { groupId } });
  audit.record('contribution.paid', { actorId: userId, entityType: 'contribution', entityId: c.id, data: { groupId, round: round.round_number, amount: c.amount, penalty, onTime, source } });
  require('./referrals').onFirstContribution(userId);

  if (round.status === 'paid_out') {
    notify(round.recipient_id, 'payout_received', 'payout_received', { amount: money.format(c.amount), group: group.name }, { data: { groupId, late: true } });
    systemMessage(groupId, `${user.full_name} settled their round ${round.round_number} contribution.`);
  } else if (group.payout_timing === 'when_complete') {
    tryPayout(round.id);
  }
  return { transaction: result, penalty, round: round.round_number };
}

// Pay out a round. With force=false this only happens when every contribution is in.
function tryPayout(roundId, { force = false } = {}) {
  const round = db.get('SELECT * FROM rounds WHERE id = ?', roundId);
  if (!round || round.status !== 'open') return null;
  const group = getGroupRow(round.group_id);
  const outstanding = db.all("SELECT * FROM contributions WHERE round_id = ? AND status = 'pending'", roundId);
  if (outstanding.length && !force) return null;

  const collected = db.get("SELECT COALESCE(SUM(amount),0) AS s FROM contributions WHERE round_id = ? AND status = 'paid'", roundId).s;
  let payoutTxn = null;
  let recovered = 0;
  db.tx(() => {
    const now = clock.iso();
    for (const c of outstanding) db.update('contributions', c.id, { status: 'defaulted', defaulted_at: now });
    if (collected > 0) {
      const fee = money.bps(collected, config.payoutFeeBps);
      // Recover any outstanding group loan from the recipient's payout.
      const loan = db.get("SELECT * FROM loans WHERE group_id = ? AND borrower_id = ? AND status IN ('disbursed','overdue')", group.id, round.recipient_id);
      if (loan) recovered = Math.min(loan.total_due - loan.amount_repaid, collected - fee);
      const legs = [
        { accountId: group.pot_account_id, amount: -collected },
        { accountId: ledger.userAccount(round.recipient_id).id, amount: collected - fee - recovered },
      ];
      if (fee) legs.push({ accountId: ledger.systemAccount(ledger.SYSTEM.fees).id, amount: fee });
      if (recovered) legs.push({ accountId: group.reserve_account_id, amount: recovered });
      payoutTxn = ledger.post({
        type: 'payout', amount: collected, fee, user_id: round.recipient_id, group_id: group.id,
        description: `${group.name} – round ${round.round_number} payout`,
        metadata: { roundNumber: round.round_number, loanRecovered: recovered, defaulters: outstanding.length },
      }, legs);
      if (loan && recovered) require('./loans').recordRepayment(loan.id, recovered, payoutTxn.id);
    }
    db.update('rounds', round.id, {
      status: 'paid_out', payout_amount: collected, payout_transaction_id: payoutTxn ? payoutTxn.id : null, paid_out_at: now,
    });
    const next = db.get('SELECT * FROM rounds WHERE group_id = ? AND round_number = ?', group.id, round.round_number + 1);
    if (!next) {
      db.update('groups', group.id, { status: 'completed' });
      systemMessage(group.id, 'All rounds are complete. Congratulations, everyone has been paid!');
    } else if (next.status === 'scheduled') {
      openRound(group.id, next.round_number);
    }
  });

  const recipient = db.get('SELECT * FROM users WHERE id = ?', round.recipient_id);
  systemMessage(group.id, `Round ${round.round_number} paid out ${money.format(collected)} to ${recipient.full_name}.`);
  if (collected > 0) {
    notify(recipient.id, 'payout_received', 'payout_received', { amount: money.format(collected - money.bps(collected, config.payoutFeeBps) - recovered), group: group.name }, { sms: true, data: { groupId: group.id } });
  }
  for (const c of outstanding) {
    const u = db.get('SELECT full_name FROM users WHERE id = ?', c.user_id);
    notify(c.user_id, 'contribution_defaulted', 'contribution_late', { group: group.name, penalty: money.format(money.bps(c.amount, group.late_penalty_bps)) }, { sms: true, data: { groupId: group.id } });
    notify(group.admin_id, 'member_defaulted', 'contribution_missed_admin', { member: u.full_name, round: round.round_number, group: group.name }, { data: { groupId: group.id } });
  }
  audit.record('round.paid_out', { entityType: 'round', entityId: round.id, data: { groupId: group.id, collected, defaulters: outstanding.map((c) => c.user_id), loanRecovered: recovered } });

  if (collected > 0 && recipient.auto_withdraw && recipient.default_bank_account_id) {
    const amount = collected - money.bps(collected, config.payoutFeeBps) - recovered;
    require('./wallet').withdraw(recipient.id, { amount, auto: true })
      .catch((err) => notify(recipient.id, 'auto_withdraw_failed', 'auto_withdraw_failed', {}, { data: { reason: err.message } }));
  }
  return payoutTxn;
}

// Admin override: settle a round after its grace period without waiting for the scheduler.
function closeRound(adminId, groupId) {
  const group = getGroupRow(groupId);
  requireAdmin(groupId, adminId);
  const round = db.get("SELECT * FROM rounds WHERE group_id = ? AND status = 'open' ORDER BY round_number LIMIT 1", groupId);
  if (!round) throw bad('no_open_round', 'There is no open round');
  if (clock.now() < graceEnd(round, group)) throw bad('too_early', 'The round can only be closed after the due date and grace period');
  audit.record('round.closed_by_admin', { actorId: adminId, entityType: 'round', entityId: round.id });
  return tryPayout(round.id, { force: true });
}

// --- Reads ---
function getGroupDetail(groupId, viewerId) {
  const g = getGroupRow(groupId);
  const viewer = viewerId ? db.get('SELECT role FROM users WHERE id = ?', viewerId) : null;
  const member = viewerId ? membership(groupId, viewerId) : null;
  if (!member && !g.is_public && !(viewer && viewer.role === 'admin')) throw forbidden('You are not a member of this group');

  const members = activeMembers(groupId).map((m) => ({
    userId: m.user_id, fullName: m.full_name, role: m.role, payoutPosition: m.payout_position, autoDebit: !!m.auto_debit,
    joinedAt: m.joined_at, trustScore: require('./reputation').trustScore(m.user_id).score,
  }));
  const rounds = db.all(`SELECT r.*, u.full_name AS recipient_name FROM rounds r JOIN users u ON u.id = r.recipient_id
                         WHERE r.group_id = ? ORDER BY r.round_number`, groupId);
  const contributions = db.all(`SELECT c.*, r.round_number, u.full_name FROM contributions c JOIN rounds r ON r.id = c.round_id
                                JOIN users u ON u.id = c.user_id WHERE c.group_id = ? ORDER BY r.round_number, u.full_name`, groupId);
  const now = clock.now();
  const roundsOut = rounds.map((r) => ({
    id: r.id, roundNumber: r.round_number, recipientId: r.recipient_id, recipientName: r.recipient_name, dueAt: r.due_at,
    graceEndsAt: graceEnd(r, g).toISOString(), status: r.status, payoutAmount: r.payout_amount, paidOutAt: r.paid_out_at,
    contributions: contributions.filter((c) => c.round_id === r.id).map((c) => ({
      id: c.id, userId: c.user_id, fullName: c.full_name, amount: c.amount, status: c.status, paidAt: c.paid_at,
      paidOnTime: c.paid_on_time == null ? null : !!c.paid_on_time, penalty: c.penalty,
      penaltyIfPaidNow: penaltyFor(c, r, g, now), late: c.status !== 'paid' && now > new Date(r.due_at),
    })),
  }));
  return {
    id: g.id, name: g.name, description: g.description, adminId: g.admin_id, contributionAmount: g.contribution_amount,
    frequency: g.frequency, maxMembers: g.max_members, payoutOrder: g.payout_order, latePenaltyBps: g.late_penalty_bps,
    gracePeriodHours: g.grace_period_hours, loanInterestBps: g.loan_interest_bps, approvalThresholdBps: g.approval_threshold_bps,
    payoutTiming: g.payout_timing, isPublic: !!g.is_public, requireKyc: !!g.require_kyc,
    inviteCode: member ? g.invite_code : undefined, status: g.status, currentRound: g.current_round, startAt: g.start_at,
    potBalance: ledger.balanceOf(g.pot_account_id), reserveBalance: ledger.balanceOf(g.reserve_account_id),
    createdAt: g.created_at, members, rounds: roundsOut, myRole: member ? member.role : null,
    myAutoDebit: member ? !!member.auto_debit : null,
  };
}

function listForUser(userId) {
  return db.all(`
    SELECT g.*, gm.role AS my_role, gm.payout_position AS my_position,
      (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id AND x.status = 'active') AS member_count,
      (SELECT r.due_at FROM rounds r WHERE r.group_id = g.id AND r.status = 'open' ORDER BY r.round_number LIMIT 1) AS next_due_at,
      (SELECT r.due_at FROM rounds r WHERE r.group_id = g.id AND r.recipient_id = gm.user_id) AS my_payout_at,
      (SELECT r.status FROM rounds r WHERE r.group_id = g.id AND r.recipient_id = gm.user_id) AS my_payout_status,
      (SELECT COUNT(*) FROM contributions c WHERE c.group_id = g.id AND c.user_id = gm.user_id AND c.status IN ('pending','defaulted')) AS my_outstanding
    FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.status = 'active'
    WHERE g.status <> 'cancelled' ORDER BY g.created_at DESC`, userId).map(summary);
}

function listPublic() {
  return db.all(`SELECT g.*, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id AND x.status = 'active') AS member_count
                 FROM groups g WHERE g.is_public = 1 AND g.status = 'forming' ORDER BY g.created_at DESC LIMIT 100`).map(summary);
}

const summary = (g) => ({
  id: g.id, name: g.name, description: g.description, contributionAmount: g.contribution_amount, frequency: g.frequency,
  maxMembers: g.max_members, memberCount: g.member_count, status: g.status, currentRound: g.current_round,
  requireKyc: !!g.require_kyc, myRole: g.my_role, myPosition: g.my_position, nextDueAt: g.next_due_at,
  myPayoutAt: g.my_payout_at, myPayoutStatus: g.my_payout_status, myOutstanding: g.my_outstanding,
});

// --- Chat ---
function postMessage(userId, groupId, body) {
  requireMember(groupId, userId);
  const row = { id: uid(), group_id: groupId, user_id: userId, body: String(body).slice(0, 2000), created_at: clock.iso() };
  db.insert('group_messages', row);
  return row;
}

function listMessages(userId, groupId, { after, limit = 100 } = {}) {
  requireMember(groupId, userId);
  return db.all(`SELECT m.*, u.full_name FROM group_messages m LEFT JOIN users u ON u.id = m.user_id
                 WHERE m.group_id = ? ${after ? 'AND m.created_at > ?' : ''} ORDER BY m.created_at ASC, m.rowid ASC LIMIT ?`,
  ...(after ? [groupId, after, limit] : [groupId, limit]));
}

module.exports = {
  FREQUENCIES, addPeriod, graceEnd, getGroupRow, membership, requireMember, requireAdmin, activeMembers, systemMessage,
  createGroup, joinGroup, leaveGroup, removeMember, cancelGroup, updateSettings, applyRuleChange, setPayoutOrder,
  setAutoDebit, startGroup, openRound, contribute, tryPayout, closeRound, penaltyFor, getGroupDetail, listForUser,
  listPublic, postMessage, listMessages,
};
