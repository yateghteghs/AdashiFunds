'use strict';
const config = require('../../config');

const providers = {
  mock: require('./mock'),
  paystack: require('./paystack'),
};

function provider(name = config.paymentProvider) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown payment provider: ${name}`);
  if (name === 'mock' && config.isProd) throw new Error('The mock payment provider cannot be used in production');
  return p;
}

module.exports = { provider, providers };
