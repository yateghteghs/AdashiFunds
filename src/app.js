'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const { authenticate, requirePlatformAdmin, errorHandler } = require('./http');
const { SUPPORTED } = require('./lib/i18n');
const groups = require('./services/groups');
const disputes = require('./services/disputes');
const kyc = require('./services/kyc');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'"], // Vue's in-browser template compiler needs eval
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  }));

  // Integrations first: they parse their own bodies (raw for webhook signatures, urlencoded for USSD).
  app.use('/api', require('./routes/integrations'));

  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, env: config.env }));
  app.get('/api/meta', (_req, res) => res.json({
    currency: config.currency, fxRates: config.fxRates, languages: SUPPORTED, frequencies: groups.FREQUENCIES,
    disputeCategories: disputes.CATEGORIES, kycIdTypes: Object.keys(kyc.FORMATS), limits: config.limits,
    payoutFeeBps: config.payoutFeeBps, transferFeeKobo: config.transferFeeKobo, paymentProvider: config.paymentProvider,
  }));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/me', authenticate, require('./routes/me'));
  app.use('/api/wallet', authenticate, require('./routes/wallet'));
  app.use('/api/groups', authenticate, require('./routes/groups'));
  app.use('/api/admin', authenticate, requirePlatformAdmin, require('./routes/admin'));
  app.use('/api', authenticate, require('./routes/community'));

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found' } }));

  // Web client (no build step): static files plus Vue's browser build from node_modules.
  app.get('/vendor/vue.js', (_req, res) => res.sendFile(require.resolve('vue/dist/vue.global.prod.js')));
  app.use(express.static(path.join(__dirname, '..', 'web')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
