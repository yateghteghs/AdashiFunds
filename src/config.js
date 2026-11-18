'use strict';
const crypto = require('node:crypto');

const env = process.env;
const isTest = env.NODE_ENV === 'test';
const isProd = env.NODE_ENV === 'production';

function required(name, devFallback) {
  if (env[name]) return env[name];
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devFallback;
}

const config = {
  env: env.NODE_ENV || 'development',
  isTest,
  isProd,
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || (isTest ? ':memory:' : 'data/adashi.db'),

  // Secrets. Production refuses to start without them; dev/test fall back to per-process random values.
  jwtSecret: required('JWT_SECRET', crypto.randomBytes(32).toString('hex')),
  // 32-byte hex key for AES-256-GCM encryption of sensitive fields (BVN/NIN, MFA secrets, account numbers).
  dataKey: required('DATA_ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex')),

  accessTokenTtl: env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS || 30),
  otpTtlMinutes: Number(env.OTP_TTL_MINUTES || 10),
  otpMaxAttempts: 5,
  // In dev the OTP is returned in API responses so the flow can be tried without an SMS gateway.
  exposeDevOtp: !isProd && env.EXPOSE_DEV_OTP !== 'false',

  currency: 'NGN',
  // Platform fee on each group payout, in basis points (50 = 0.5%).
  payoutFeeBps: Number(env.PAYOUT_FEE_BPS || 50),
  // Flat fee on peer-to-peer transfers, in kobo.
  transferFeeKobo: Number(env.TRANSFER_FEE_KOBO || 0),
  referralPoints: Number(env.REFERRAL_POINTS || 100),
  // Wallet bonus (kobo) paid to a referrer when their referral makes a first contribution.
  referralBonusKobo: Number(env.REFERRAL_BONUS_KOBO || 0),

  // Limits by KYC tier, in kobo. Tier 0 = unverified, 1 = ID verified, 2 = enhanced.
  limits: {
    0: { singleWithdrawal: 0, dailyOutflow: 50_000_00 },
    1: { singleWithdrawal: 200_000_00, dailyOutflow: 500_000_00 },
    2: { singleWithdrawal: 5_000_000_00, dailyOutflow: 10_000_000_00 },
  },

  paymentProvider: env.PAYMENT_PROVIDER || 'mock', // mock | paystack
  paystackSecretKey: env.PAYSTACK_SECRET_KEY || '',
  kycProvider: env.KYC_PROVIDER || 'mock',
  notifier: env.NOTIFIER || (isTest ? 'memory' : 'console'),

  // Display-only FX rates: 1 NGN = x units.
  fxRates: JSON.parse(env.FX_RATES || '{"NGN":1,"USD":0.00065,"GHS":0.0098,"XOF":0.39,"KES":0.084}'),

  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 60_000),
  publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`,
};

module.exports = config;
