'use strict';
// Paystack adapter (https://paystack.com/docs/api). Supports card, bank transfer, USSD and mobile
// money channels for deposits, and Transfers for withdrawals. Requires PAYSTACK_SECRET_KEY.
// Flutterwave or direct bank APIs can be added by implementing the same interface.
const crypto = require('node:crypto');
const config = require('../../config');

const BASE = 'https://api.paystack.co';

async function call(method, path, body) {
  if (!config.paystackSecretKey) throw new Error('PAYSTACK_SECRET_KEY is not configured');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${config.paystackSecretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    const err = new Error(json.message || `Paystack ${method} ${path} failed (${res.status})`);
    err.status = 502;
    err.code = 'payment_provider_error';
    throw err;
  }
  return json.data;
}

module.exports = {
  name: 'paystack',
  async listBanks() {
    const data = await call('GET', '/bank?country=nigeria&perPage=200');
    return data.map((b) => ({ code: b.code, name: b.name }));
  },
  async resolveAccount(bankCode, accountNumber) {
    const data = await call('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    return { accountName: data.account_name };
  },
  async initializeDeposit({ reference, amount, email, callbackUrl }) {
    const data = await call('POST', '/transaction/initialize', {
      reference, amount, email, currency: 'NGN', callback_url: callbackUrl,
      channels: ['card', 'bank', 'ussd', 'bank_transfer', 'mobile_money'],
    });
    return { status: 'pending', authorizationUrl: data.authorization_url, providerRef: data.access_code, reference };
  },
  async verifyDeposit(reference) {
    const data = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return { status: data.status === 'success' ? 'success' : data.status === 'failed' ? 'failed' : 'pending', amount: data.amount, reference };
  },
  async transfer({ reference, amount, bankCode, accountNumber, accountName, reason }) {
    const recipient = await call('POST', '/transferrecipient', {
      type: 'nuban', name: accountName, account_number: accountNumber, bank_code: bankCode, currency: 'NGN',
    });
    const data = await call('POST', '/transfer', {
      source: 'balance', amount, recipient: recipient.recipient_code, reference, reason,
    });
    return { status: data.status === 'success' ? 'success' : 'pending', providerRef: data.transfer_code, reference };
  },
  verifyWebhook(rawBody, headers) {
    const signature = headers['x-paystack-signature'];
    if (!signature || !rawBody) return false;
    const expected = crypto.createHmac('sha512', config.paystackSecretKey).update(rawBody).digest('hex');
    return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  },
  parseWebhook(body) {
    const d = body.data || {};
    const map = {
      'charge.success': 'deposit.success',
      'transfer.success': 'transfer.success',
      'transfer.failed': 'transfer.failed',
      'transfer.reversed': 'transfer.failed',
    };
    return { event: map[body.event] || body.event, reference: d.reference, amount: d.amount, status: d.status };
  },
};
