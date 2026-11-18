'use strict';
// Development/test provider: every operation succeeds instantly. Never enable in production.
const { randomToken } = require('../../lib/crypto');

const BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'GTBank' },
  { code: '011', name: 'First Bank' },
  { code: '033', name: 'UBA' },
  { code: '057', name: 'Zenith Bank' },
  { code: '100004', name: 'Opay' },
  { code: '999991', name: 'PalmPay' },
  { code: '327', name: 'Paga' },
  { code: '50211', name: 'Kuda' },
];

module.exports = {
  name: 'mock',
  async listBanks() { return BANKS; },
  async resolveAccount(bankCode, accountNumber) {
    if (!/^\d{10}$/.test(accountNumber)) return null;
    return { accountName: `Test Account ${accountNumber.slice(-4)}` };
  },
  async initializeDeposit({ reference, amount }) {
    return { status: 'success', providerRef: `mock_${randomToken(8)}`, amount, reference };
  },
  async verifyDeposit(reference) {
    return { status: 'success', reference };
  },
  async transfer({ reference }) {
    return { status: 'success', providerRef: `mock_tr_${randomToken(8)}`, reference };
  },
  verifyWebhook() { return true; },
  parseWebhook(body) {
    return { event: body.event, reference: body.reference, amount: body.amount, status: body.status };
  },
};
