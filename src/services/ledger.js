'use strict';
// Double-entry ledger. Every money movement is one `transactions` row plus a set of
// `ledger_entries` whose amounts sum to zero. Balances are cached on `accounts` and updated in the
// same database transaction, with a non-negative check for user and group accounts.
const db = require('../db');
const clock = require('../lib/clock');
const { uid, randomToken } = require('../lib/crypto');
const { bad, conflict } = require('../lib/errors');
const config = require('../config');

const SYSTEM = {
  external: 'external',   // money entering/leaving the platform via payment rails (may go negative)
  fees: 'fees',           // platform revenue
  promotions: 'promotions', // referral bonuses and incentives (may go negative)
  clearing: 'clearing',   // withdrawals in flight to a bank
};

function ensureAccount(ownerType, ownerId, { allowNegative = false } = {}) {
  let acct = db.get('SELECT * FROM accounts WHERE owner_type = ? AND owner_id = ?', ownerType, ownerId);
  if (!acct) {
    acct = {
      id: uid(), owner_type: ownerType, owner_id: ownerId, currency: config.currency,
      balance: 0, allow_negative: allowNegative ? 1 : 0, created_at: clock.iso(),
    };
    db.insert('accounts', acct);
  }
  return acct;
}

const systemAccount = (name) =>
  ensureAccount('system', name, { allowNegative: name === SYSTEM.external || name === SYSTEM.promotions });
const userAccount = (userId) => ensureAccount('user', userId);
const balanceOf = (accountId) => db.get('SELECT balance FROM accounts WHERE id = ?', accountId).balance;

const newReference = (prefix = 'ADF') => `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomToken(6).toUpperCase()}`;

/**
 * Post a balanced transaction.
 * @param {object} t - transaction fields (type, amount, user_id, ...)
 * @param {Array<{accountId:string, amount:number}>} legs - signed amounts that must sum to 0
 */
function post(t, legs) {
  const sum = legs.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error(`Unbalanced transaction (${sum})`);
  if (!Number.isInteger(t.amount) || t.amount <= 0) throw bad('invalid_amount', 'Amount must be a positive whole number of kobo');

  return db.tx(() => {
    const now = clock.iso();
    const txn = {
      id: uid(),
      reference: t.reference || newReference(),
      type: t.type,
      status: t.status || 'success',
      amount: t.amount,
      fee: t.fee || 0,
      currency: config.currency,
      user_id: t.user_id || null,
      counterparty_user_id: t.counterparty_user_id || null,
      group_id: t.group_id || null,
      description: t.description || null,
      provider: t.provider || null,
      provider_ref: t.provider_ref || null,
      metadata: t.metadata ? JSON.stringify(t.metadata) : null,
      created_at: now,
      completed_at: (t.status || 'success') === 'success' ? now : null,
    };
    if (db.get('SELECT 1 FROM transactions WHERE reference = ?', txn.reference)) {
      throw conflict('duplicate_reference', 'A transaction with this reference already exists');
    }
    db.insert('transactions', txn);
    applyLegs(txn.id, legs);
    return txn;
  });
}

// Add balanced entries to an existing transaction (used to settle or reverse pending ones).
function applyLegs(txnId, legs) {
  const sum = legs.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error(`Unbalanced legs (${sum})`);
  db.tx(() => {
    const now = clock.iso();
    for (const leg of legs) {
      if (leg.amount === 0) continue;
      const acct = db.get('SELECT * FROM accounts WHERE id = ?', leg.accountId);
      const next = acct.balance + leg.amount;
      if (next < 0 && !acct.allow_negative) {
        throw bad('insufficient_funds', 'Insufficient balance for this transaction');
      }
      db.run('UPDATE accounts SET balance = ? WHERE id = ?', next, acct.id);
      db.insert('ledger_entries', {
        id: uid(), transaction_id: txnId, account_id: acct.id, amount: leg.amount, balance_after: next, created_at: now,
      });
    }
  });
}

function setStatus(txnId, status, extra = {}) {
  db.update('transactions', txnId, {
    status, ...extra, completed_at: ['success', 'failed', 'reversed'].includes(status) ? clock.iso() : null,
  });
}

const transfer = (fromId, toId, amount, t) =>
  post({ ...t, amount }, [{ accountId: fromId, amount: -amount }, { accountId: toId, amount }]);

// Integrity check: cached balances equal the sum of entries, and the ledger as a whole nets to zero.
function reconcile() {
  const mismatches = db.all(`
    SELECT a.id, a.owner_type, a.owner_id, a.balance, COALESCE(SUM(e.amount), 0) AS computed
    FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
    GROUP BY a.id HAVING a.balance <> computed`);
  const total = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM ledger_entries').s;
  return { ok: mismatches.length === 0 && total === 0, mismatches, netTotal: total };
}

module.exports = {
  SYSTEM, ensureAccount, systemAccount, userAccount, balanceOf, post, applyLegs, setStatus, transfer, newReference, reconcile,
};
