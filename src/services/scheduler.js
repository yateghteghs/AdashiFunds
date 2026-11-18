'use strict';
// Time-driven enforcement of group rules. `runDueJobs()` is idempotent and safe to call at any
// frequency; in production run it from one worker (or a cron / Cloud Scheduler hitting an
// internal endpoint) to avoid duplicate SMS reminders.
const db = require('../db');
const clock = require('../lib/clock');
const money = require('../lib/money');
const groups = require('./groups');
const governance = require('./governance');
const loans = require('./loans');
const { notify } = require('./notifications');

function sendReminders(now) {
  const soon = new Date(now.getTime() + 24 * 3_600_000).toISOString();
  const rounds = db.all("SELECT r.*, g.name, g.contribution_amount FROM rounds r JOIN groups g ON g.id = r.group_id WHERE r.status = 'open' AND r.reminder_sent = 0 AND r.due_at <= ?", soon);
  for (const r of rounds) {
    for (const c of db.all("SELECT * FROM contributions WHERE round_id = ? AND status = 'pending'", r.id)) {
      notify(c.user_id, 'contribution_due', 'contribution_due', { amount: money.format(c.amount), group: r.name, when: r.due_at.slice(0, 10) }, { sms: true, data: { groupId: r.group_id } });
    }
    db.update('rounds', r.id, { reminder_sent: 1 });
  }
  return rounds.length;
}

function runAutoDebits(now) {
  const due = db.all(`SELECT c.*, g.name AS group_name FROM contributions c
    JOIN rounds r ON r.id = c.round_id JOIN groups g ON g.id = c.group_id
    JOIN group_members gm ON gm.group_id = c.group_id AND gm.user_id = c.user_id AND gm.status = 'active'
    WHERE r.status = 'open' AND c.status = 'pending' AND gm.auto_debit = 1 AND c.auto_debit_attempted_at IS NULL AND r.due_at <= ?`, now.toISOString());
  let ok = 0;
  for (const c of due) {
    db.update('contributions', c.id, { auto_debit_attempted_at: now.toISOString() });
    try {
      groups.contribute(c.user_id, c.group_id, { contributionId: c.id, source: 'auto_debit' });
      ok++;
    } catch (err) {
      notify(c.user_id, 'auto_debit_failed', 'auto_debit_failed', { group: c.group_name, reason: err.message }, { sms: true, data: { groupId: c.group_id } });
    }
  }
  return { attempted: due.length, succeeded: ok };
}

function notifyOverdue(now) {
  const rows = db.all(`SELECT c.*, r.due_at, g.name, g.grace_period_hours FROM contributions c JOIN rounds r ON r.id = c.round_id JOIN groups g ON g.id = c.group_id
    WHERE r.status = 'open' AND c.status = 'pending' AND c.late_notified = 0 AND r.due_at < ?`, now.toISOString());
  for (const c of rows) {
    const graceEnds = new Date(new Date(c.due_at).getTime() + c.grace_period_hours * 3_600_000);
    notify(c.user_id, 'contribution_overdue', 'contribution_overdue', { group: c.name, deadline: graceEnds.toISOString().slice(0, 16).replace('T', ' ') }, { sms: true, data: { groupId: c.group_id } });
    db.update('contributions', c.id, { late_notified: 1 });
  }
  return rows.length;
}

// Rounds whose due date has passed and are fully paid (covers on_due_date payout timing).
function payDueRounds(now) {
  const rounds = db.all("SELECT * FROM rounds WHERE status = 'open' AND due_at <= ?", now.toISOString());
  let n = 0;
  for (const r of rounds) if (groups.tryPayout(r.id)) n++;
  return n;
}

// Open the next round's collection window once the previous round's due date has passed.
function openNextRounds(now) {
  const rows = db.all(`SELECT nxt.group_id, nxt.round_number FROM rounds nxt
    JOIN rounds prev ON prev.group_id = nxt.group_id AND prev.round_number = nxt.round_number - 1
    JOIN groups g ON g.id = nxt.group_id
    WHERE nxt.status = 'scheduled' AND g.status = 'active' AND prev.due_at <= ?`, now.toISOString());
  for (const r of rows) groups.openRound(r.group_id, r.round_number);
  return rows.length;
}

// After due date + grace period: settle the round, marking unpaid contributions as defaults.
function settleExpiredRounds(now) {
  const rows = db.all(`SELECT r.id, r.due_at, g.grace_period_hours FROM rounds r JOIN groups g ON g.id = r.group_id WHERE r.status = 'open'`);
  let n = 0;
  for (const r of rows) {
    if (new Date(r.due_at).getTime() + r.grace_period_hours * 3_600_000 <= now.getTime()) {
      groups.tryPayout(r.id, { force: true });
      n++;
    }
  }
  return n;
}

function runDueJobs() {
  const now = clock.now();
  const out = {};
  const step = (name, fn) => {
    try { out[name] = fn(now); } catch (err) { out[name] = { error: err.message }; console.error(`[scheduler] ${name} failed`, err); }
  };
  step('reminders', sendReminders);
  step('autoDebits', runAutoDebits);
  step('overdueNotices', notifyOverdue);
  step('payouts', payDueRounds);
  step('settled', settleExpiredRounds);
  step('openedRounds', openNextRounds);
  step('expiredProposals', () => governance.expireDue());
  step('overdueLoans', () => loans.markOverdue());
  return out;
}

let timer = null;
function start(intervalMs) {
  if (timer) return;
  timer = setInterval(runDueJobs, intervalMs);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runDueJobs, start, stop };
