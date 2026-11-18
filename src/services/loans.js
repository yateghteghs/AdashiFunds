'use strict';
// Emergency loans from a group's reserve fund (late penalties, loan interest and voluntary top-ups).
// Every loan needs group approval by vote; repayment is from the wallet, and any balance still owed
// is recovered automatically from the borrower's next payout in that group.
const db = require('../db');
const clock = require('../lib/clock');
const { uid } = require('../lib/crypto');
const { bad, notFound, conflict, forbidden } = require('../lib/errors');
const money = require('../lib/money');
const ledger = require('./ledger');
const groups = require('./groups');
const audit = require('./audit');
const { notify } = require('./notifications');

function request(userId, groupId, { amount, termDays = 30, reason }) {
  const group = groups.getGroupRow(groupId);
  groups.requireMember(groupId, userId);
  if (group.status !== 'active') throw conflict('group_not_active', 'Loans are only available in active groups');
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (user.kyc_status !== 'verified') throw forbidden('Verify your identity (KYC) before requesting a loan');
  if (db.get("SELECT 1 FROM loans WHERE borrower_id = ? AND group_id = ? AND status IN ('pending_vote','disbursed','overdue')", userId, groupId)) {
    throw conflict('loan_exists', 'You already have an open loan in this group');
  }
  const reserve = ledger.balanceOf(group.reserve_account_id);
  if (amount > reserve) throw bad('insufficient_reserve', `The group reserve only has ${money.format(reserve)}`);
  if (termDays < 1 || termDays > 180) throw bad('invalid_term', 'Loan term must be 1 to 180 days');

  const loan = {
    id: uid(), group_id: groupId, borrower_id: userId, proposal_id: null, principal: amount,
    interest_bps: group.loan_interest_bps, total_due: amount + money.bps(amount, group.loan_interest_bps), amount_repaid: 0,
    reason: reason || null, term_days: termDays, status: 'pending_vote', due_at: null, disbursed_at: null, created_at: clock.iso(),
  };
  db.insert('loans', loan);
  const proposal = require('./governance').create(groupId, userId, {
    type: 'loan', title: `Loan of ${money.format(amount)} to ${user.full_name} for ${termDays} days`,
    payload: { loanId: loan.id, amount, termDays, reason }, excludedUserId: userId,
  });
  db.update('loans', loan.id, { proposal_id: proposal.id });
  audit.record('loan.requested', { actorId: userId, entityType: 'loan', entityId: loan.id, data: { amount, termDays } });
  return get(loan.id);
}

function disburse(loanId) {
  const loan = db.get('SELECT * FROM loans WHERE id = ?', loanId);
  if (!loan || loan.status !== 'pending_vote') throw conflict('loan_not_pending', 'Loan is not awaiting approval');
  const group = groups.getGroupRow(loan.group_id);
  const dueAt = new Date(clock.now().getTime() + loan.term_days * 86_400_000).toISOString();
  db.tx(() => {
    ledger.transfer(group.reserve_account_id, ledger.userAccount(loan.borrower_id).id, loan.principal, {
      type: 'loan_disbursement', user_id: loan.borrower_id, group_id: group.id, description: `${group.name} – emergency loan`,
      metadata: { loanId },
    });
    db.update('loans', loanId, { status: 'disbursed', disbursed_at: clock.iso(), due_at: dueAt });
  });
  notify(loan.borrower_id, 'loan_disbursed', 'loan_disbursed', {
    amount: money.format(loan.principal), group: group.name, total: money.format(loan.total_due), due: dueAt.slice(0, 10),
  }, { sms: true, data: { loanId } });
  audit.record('loan.disbursed', { entityType: 'loan', entityId: loanId, data: { amount: loan.principal } });
}

function markRejected(loanId) {
  db.run("UPDATE loans SET status = 'rejected' WHERE id = ? AND status = 'pending_vote'", loanId);
}

// Bookkeeping for a repayment already moved on the ledger (used by payout recovery).
function recordRepayment(loanId, amount) {
  const loan = db.get('SELECT * FROM loans WHERE id = ?', loanId);
  const repaid = loan.amount_repaid + amount;
  db.update('loans', loanId, { amount_repaid: repaid, status: repaid >= loan.total_due ? 'repaid' : loan.status });
  audit.record('loan.repayment', { entityType: 'loan', entityId: loanId, data: { amount, repaid } });
}

function repay(userId, loanId, { amount } = {}) {
  const loan = db.get('SELECT * FROM loans WHERE id = ? AND borrower_id = ?', loanId, userId);
  if (!loan) throw notFound('Loan');
  if (!['disbursed', 'overdue'].includes(loan.status)) throw conflict('loan_not_open', 'This loan is not open for repayment');
  const outstanding = loan.total_due - loan.amount_repaid;
  const pay = Math.min(amount || outstanding, outstanding);
  const group = groups.getGroupRow(loan.group_id);
  db.tx(() => {
    ledger.transfer(ledger.userAccount(userId).id, group.reserve_account_id, pay, {
      type: 'loan_repayment', user_id: userId, group_id: group.id, description: `${group.name} – loan repayment`, metadata: { loanId },
    });
    recordRepayment(loanId, pay);
  });
  return get(loanId);
}

// Anyone in the group may top up the reserve that funds loans.
function fundReserve(userId, groupId, amount) {
  const group = groups.getGroupRow(groupId);
  groups.requireMember(groupId, userId);
  ledger.transfer(ledger.userAccount(userId).id, group.reserve_account_id, amount, {
    type: 'contribution', user_id: userId, group_id: groupId, description: `${group.name} – reserve top-up`, metadata: { reserve: true },
  });
  audit.record('reserve.funded', { actorId: userId, entityType: 'group', entityId: groupId, data: { amount } });
  return { reserveBalance: ledger.balanceOf(group.reserve_account_id) };
}

function markOverdue() {
  const due = db.all("SELECT * FROM loans WHERE status = 'disbursed' AND due_at < ?", clock.iso());
  for (const loan of due) {
    db.update('loans', loan.id, { status: 'overdue' });
    const group = groups.getGroupRow(loan.group_id);
    notify(loan.borrower_id, 'loan_overdue', 'loan_overdue', { group: group.name, amount: money.format(loan.total_due - loan.amount_repaid) }, { sms: true, data: { loanId: loan.id } });
    notify(group.admin_id, 'loan_overdue', 'loan_overdue', { group: group.name, amount: money.format(loan.total_due - loan.amount_repaid) }, { data: { loanId: loan.id } });
  }
  return due.length;
}

function present(l) {
  const u = db.get('SELECT full_name FROM users WHERE id = ?', l.borrower_id);
  return {
    id: l.id, groupId: l.group_id, borrowerId: l.borrower_id, borrowerName: u && u.full_name, proposalId: l.proposal_id,
    principal: l.principal, interestBps: l.interest_bps, totalDue: l.total_due, amountRepaid: l.amount_repaid,
    outstanding: l.total_due - l.amount_repaid, reason: l.reason, termDays: l.term_days, status: l.status, dueAt: l.due_at,
    disbursedAt: l.disbursed_at, createdAt: l.created_at,
  };
}

function get(loanId) {
  const l = db.get('SELECT * FROM loans WHERE id = ?', loanId);
  if (!l) throw notFound('Loan');
  return present(l);
}

const listForUser = (userId) => db.all('SELECT * FROM loans WHERE borrower_id = ? ORDER BY created_at DESC', userId).map(present);

function listForGroup(groupId, viewerId) {
  groups.requireMember(groupId, viewerId);
  return db.all('SELECT * FROM loans WHERE group_id = ? ORDER BY created_at DESC', groupId).map(present);
}

module.exports = { request, disburse, markRejected, recordRepayment, repay, fundReserve, markOverdue, get, listForUser, listForGroup };
