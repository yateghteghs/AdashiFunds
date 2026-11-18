'use strict';
const db = require('../db');
const clock = require('../lib/clock');
const config = require('../config');
const { uid, encrypt, decrypt } = require('../lib/crypto');
const { AppError, bad, forbidden, notFound, conflict } = require('../lib/errors');
const money = require('../lib/money');
const ledger = require('./ledger');
const fraud = require('./fraud');
const audit = require('./audit');
const { notify } = require('./notifications');
const { provider } = require('./payments');

function balance(userId) {
  const acct = ledger.userAccount(userId);
  return { balance: acct.balance, currency: acct.currency, accountId: acct.id };
}

// Transaction history with the signed effect on this user's wallet.
function history(userId, { limit = 50, offset = 0, from, to, type } = {}) {
  const acct = ledger.userAccount(userId);
  const params = [acct.id, userId, userId, acct.id];
  let where = '';
  if (from) { where += ' AND t.created_at >= ?'; params.push(from); }
  if (to) { where += ' AND t.created_at < ?'; params.push(to); }
  if (type) { where += ' AND t.type = ?'; params.push(type); }
  params.push(limit, offset);
  return db.all(`
    SELECT t.*, (SELECT COALESCE(SUM(e.amount), 0) FROM ledger_entries e WHERE e.transaction_id = t.id AND e.account_id = ?) AS net,
           g.name AS group_name, cu.full_name AS counterparty_name, u.full_name AS user_name
    FROM transactions t
    LEFT JOIN groups g ON g.id = t.group_id
    LEFT JOIN users cu ON cu.id = t.counterparty_user_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE (t.user_id = ? OR t.counterparty_user_id = ?
           OR EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.transaction_id = t.id AND e2.account_id = ?))
    ${where}
    ORDER BY t.created_at DESC, t.rowid DESC LIMIT ? OFFSET ?`, ...params)
    .map((t) => ({ ...t, metadata: t.metadata ? JSON.parse(t.metadata) : null }));
}

function outflowLast24h(userId) {
  const since = new Date(clock.now().getTime() - 86_400_000).toISOString();
  return db.get(`SELECT COALESCE(SUM(amount + fee), 0) AS s FROM transactions
                 WHERE user_id = ? AND type IN ('transfer','withdrawal') AND status IN ('success','pending') AND created_at >= ?`,
  userId, since).s;
}

function enforceLimits(user, amount, type) {
  const limits = config.limits[user.kyc_tier] || config.limits[0];
  if (type === 'withdrawal') {
    if (limits.singleWithdrawal === 0) throw forbidden('Verify your identity (KYC) before withdrawing');
    if (amount > limits.singleWithdrawal) {
      throw bad('limit_exceeded', `Your single withdrawal limit is ${money.format(limits.singleWithdrawal)}. Upgrade your KYC tier to raise it.`);
    }
  }
  if (outflowLast24h(user.id) + amount > limits.dailyOutflow) {
    throw bad('limit_exceeded', `This exceeds your 24-hour limit of ${money.format(limits.dailyOutflow)}`);
  }
}

// --- Deposits ---
async function initDeposit(userId, { amount, channel = 'card' }) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  const reference = ledger.newReference('DEP');
  const p = provider();
  ledger.post({
    reference, type: 'deposit', status: 'pending', amount, user_id: userId, provider: p.name,
    description: `Wallet funding via ${channel}`, metadata: { channel },
  }, []);
  const result = await p.initializeDeposit({
    reference, amount, email: user.email || `${user.phone.replace('+', '')}@users.adashifunds.local`, channel,
    callbackUrl: `${config.publicBaseUrl}/#/wallet?ref=${reference}`,
  });
  db.run('UPDATE transactions SET provider_ref = ? WHERE reference = ?', result.providerRef || null, reference);
  if (result.status === 'success') settleDeposit(reference, amount);
  const txn = db.get('SELECT status FROM transactions WHERE reference = ?', reference);
  return { reference, status: txn.status, authorizationUrl: result.authorizationUrl || null };
}

// Idempotent: safe to call from both the webhook and the client-side verify.
function settleDeposit(reference, providerAmount) {
  return db.tx(() => {
    const txn = db.get("SELECT * FROM transactions WHERE reference = ? AND type = 'deposit'", reference);
    if (!txn) throw notFound('Deposit');
    if (txn.status === 'success') return txn;
    if (txn.status !== 'pending') throw conflict('deposit_closed', `Deposit is ${txn.status}`);
    if (providerAmount != null && Number(providerAmount) !== txn.amount) {
      ledger.setStatus(txn.id, 'failed');
      audit.record('deposit.amount_mismatch', { entityType: 'transaction', entityId: txn.id, data: { expected: txn.amount, got: providerAmount } });
      throw bad('amount_mismatch', 'Deposit amount does not match');
    }
    const user = ledger.userAccount(txn.user_id);
    ledger.applyLegs(txn.id, [
      { accountId: ledger.systemAccount(ledger.SYSTEM.external).id, amount: -txn.amount },
      { accountId: user.id, amount: txn.amount },
    ]);
    ledger.setStatus(txn.id, 'success');
    audit.record('deposit.settled', { actorId: txn.user_id, entityType: 'transaction', entityId: txn.id, data: { amount: txn.amount } });
    return db.get('SELECT * FROM transactions WHERE id = ?', txn.id);
  });
}

async function verifyDeposit(userId, reference) {
  const txn = db.get("SELECT * FROM transactions WHERE reference = ? AND user_id = ? AND type = 'deposit'", reference, userId);
  if (!txn) throw notFound('Deposit');
  if (txn.status === 'pending') {
    const r = await provider(txn.provider).verifyDeposit(reference);
    if (r.status === 'success') settleDeposit(reference, r.amount);
    else if (r.status === 'failed') ledger.setStatus(txn.id, 'failed');
  }
  return db.get('SELECT reference, status, amount FROM transactions WHERE id = ?', txn.id);
}

// --- Bank accounts ---
async function addBankAccount(userId, { bankCode, accountNumber }) {
  const p = provider();
  const banks = await p.listBanks();
  const bank = banks.find((b) => b.code === bankCode);
  if (!bank) throw bad('invalid_bank', 'Unknown bank');
  const resolved = await p.resolveAccount(bankCode, accountNumber);
  if (!resolved) throw bad('account_not_found', 'Could not verify that account number');
  const row = {
    id: uid(), user_id: userId, bank_code: bankCode, bank_name: bank.name, account_number_enc: encrypt(accountNumber),
    account_last4: accountNumber.slice(-4), account_name: resolved.accountName, created_at: clock.iso(),
  };
  db.insert('bank_accounts', row);
  const user = db.get('SELECT default_bank_account_id FROM users WHERE id = ?', userId);
  if (!user.default_bank_account_id) db.update('users', userId, { default_bank_account_id: row.id });
  audit.record('bank_account.added', { actorId: userId, entityType: 'bank_account', entityId: row.id });
  return publicBank(row);
}

const publicBank = (b) => ({ id: b.id, bankCode: b.bank_code, bankName: b.bank_name, accountLast4: b.account_last4, accountName: b.account_name });
const listBankAccounts = (userId) => db.all('SELECT * FROM bank_accounts WHERE user_id = ? ORDER BY created_at', userId).map(publicBank);

function removeBankAccount(userId, id) {
  const b = db.get('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?', id, userId);
  if (!b) throw notFound('Bank account');
  db.tx(() => {
    db.run('UPDATE users SET default_bank_account_id = NULL WHERE id = ? AND default_bank_account_id = ?', userId, id);
    db.run('DELETE FROM bank_accounts WHERE id = ?', id);
  });
}

// --- Withdrawals ---
async function withdraw(userId, { amount, bankAccountId, deviceId, auto = false }) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  const bank = db.get('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?', bankAccountId || user.default_bank_account_id, userId);
  if (!bank) throw bad('no_bank_account', 'Add a bank account first');
  enforceLimits(user, amount, 'withdrawal');
  const reference = ledger.newReference('WDR');
  fraud.guard({ userId, amount, type: 'withdrawal', deviceId, reference });

  const p = provider();
  const clearing = ledger.systemAccount(ledger.SYSTEM.clearing);
  const txn = ledger.post({
    reference, type: 'withdrawal', status: 'pending', amount, user_id: userId, provider: p.name,
    description: `${auto ? 'Auto-withdrawal' : 'Withdrawal'} to ${bank.bank_name} ****${bank.account_last4}`,
    metadata: { bankAccountId: bank.id, auto },
  }, [{ accountId: ledger.userAccount(userId).id, amount: -amount }, { accountId: clearing.id, amount }]);

  try {
    const r = await p.transfer({
      reference, amount, bankCode: bank.bank_code, accountNumber: decrypt(bank.account_number_enc),
      accountName: bank.account_name, reason: 'AdashiFunds withdrawal',
    });
    db.run('UPDATE transactions SET provider_ref = ? WHERE id = ?', r.providerRef || null, txn.id);
    if (r.status === 'success') completeWithdrawal(reference, true);
  } catch (err) {
    completeWithdrawal(reference, false, err.message);
    audit.record('withdrawal.failed', { actorId: userId, entityType: 'transaction', entityId: txn.id, data: { reason: err.message } });
    throw new AppError(502, 'withdrawal_failed', 'The bank transfer could not be completed. Your wallet has been refunded.');
  }
  audit.record('withdrawal.initiated', { actorId: userId, entityType: 'transaction', entityId: txn.id, data: { amount } });
  return db.get('SELECT id, reference, status, amount FROM transactions WHERE id = ?', txn.id);
}

// Idempotent completion, from the provider response or its webhook.
function completeWithdrawal(reference, success, reason) {
  db.tx(() => {
    const txn = db.get("SELECT * FROM transactions WHERE reference = ? AND type = 'withdrawal'", reference);
    if (!txn || txn.status !== 'pending') return;
    const clearing = ledger.systemAccount(ledger.SYSTEM.clearing);
    if (success) {
      ledger.applyLegs(txn.id, [{ accountId: clearing.id, amount: -txn.amount }, { accountId: ledger.systemAccount(ledger.SYSTEM.external).id, amount: txn.amount }]);
      ledger.setStatus(txn.id, 'success');
    } else {
      ledger.applyLegs(txn.id, [{ accountId: clearing.id, amount: -txn.amount }, { accountId: ledger.userAccount(txn.user_id).id, amount: txn.amount }]);
      ledger.setStatus(txn.id, 'reversed', { description: `${txn.description} (reversed${reason ? `: ${reason}` : ''})` });
    }
  });
}

// --- Peer-to-peer transfers ---
function resolveRecipient({ recipientId, recipient }) {
  if (recipientId) return db.get('SELECT * FROM users WHERE id = ?', recipientId);
  return require('./auth').findByIdentifier(recipient);
}

function transferToUser(userId, { recipientId, recipient, amount, note, deviceId }) {
  const target = resolveRecipient({ recipientId, recipient });
  if (!target) throw notFound('Recipient');
  if (target.id === userId) throw bad('self_transfer', 'You cannot send money to yourself');
  if (target.status !== 'active') throw bad('recipient_unavailable', 'This recipient cannot receive transfers');
  const sender = db.get('SELECT * FROM users WHERE id = ?', userId);
  const fee = config.transferFeeKobo;
  enforceLimits(sender, amount + fee, 'transfer');
  const reference = ledger.newReference('TRF');
  fraud.guard({ userId, amount, type: 'transfer', deviceId, reference });

  const legs = [
    { accountId: ledger.userAccount(userId).id, amount: -(amount + fee) },
    { accountId: ledger.userAccount(target.id).id, amount },
  ];
  if (fee) legs.push({ accountId: ledger.systemAccount(ledger.SYSTEM.fees).id, amount: fee });
  const txn = ledger.post({
    reference, type: 'transfer', amount, fee, user_id: userId, counterparty_user_id: target.id,
    description: note ? `Transfer: ${note}` : `Transfer to ${target.full_name}`,
  }, legs);
  notify(target.id, 'transfer_received', 'transfer_received', { amount: money.format(amount), sender: sender.full_name }, { data: { transactionId: txn.id } });
  audit.record('transfer.completed', { actorId: userId, entityType: 'transaction', entityId: txn.id, data: { to: target.id, amount } });
  return { ...txn, recipientName: target.full_name };
}

// Payload encoded into a QR code so another user can scan and pay.
function paymentRequestPayload(userId, amount) {
  const u = db.get('SELECT id, full_name FROM users WHERE id = ?', userId);
  const params = new URLSearchParams({ to: u.id, name: u.full_name });
  if (amount) params.set('amount', String(amount));
  return `adashi://pay?${params.toString()}`;
}

module.exports = {
  balance, history, initDeposit, settleDeposit, verifyDeposit, addBankAccount, listBankAccounts, removeBankAccount,
  withdraw, completeWithdrawal, transferToUser, paymentRequestPayload, outflowLast24h, enforceLimits,
};
