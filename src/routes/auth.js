'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const auth = require('../services/auth');
const { validate, publicUser, z, password } = require('../http');
const { SUPPORTED } = require('../lib/i18n');

const router = express.Router();

// Brute-force protection on credential endpoints.
router.use(rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 10_000 : 50, standardHeaders: 'draft-8', legacyHeaders: false }));

const session = (r) => ({ user: publicUser(r.user), accessToken: r.accessToken, refreshToken: r.refreshToken });

router.post('/register', validate(z.object({
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().min(7).max(20),
  email: z.email().optional(),
  password,
  referralCode: z.string().max(20).optional(),
  language: z.enum(SUPPORTED).optional(),
})), (req, res) => {
  const { user, devOtp } = auth.register(req.body);
  res.status(201).json({ user: publicUser(user), next: 'verify_phone', devOtp });
});

router.post('/verify-phone', validate(z.object({ phone: z.string(), code: z.string().length(6) })), (req, res) => {
  const user = auth.verifyPhone(req.body);
  res.json(session({ user, ...auth.issueTokens(user, req.get('x-device-id')) }));
});

router.post('/resend-verification', validate(z.object({ phone: z.string() })), (req, res) => {
  res.json({ ok: true, ...auth.resendVerification(req.body) });
});

router.post('/login', validate(z.object({ identifier: z.string().min(3), password: z.string().min(1) })), (req, res) => {
  const r = auth.login({ ...req.body, deviceId: req.get('x-device-id'), ip: req.ip });
  if (r.mfaRequired) return res.json(r);
  res.json(session(r));
});

router.post('/mfa/sms', validate(z.object({ mfaToken: z.string() })), (req, res) => {
  res.json({ ok: true, ...auth.sendMfaSms(req.body) });
});

router.post('/mfa/verify', validate(z.object({
  mfaToken: z.string(), code: z.string().length(6), method: z.enum(['totp', 'sms']).optional(),
})), (req, res) => {
  res.json(session(auth.completeMfa({ ...req.body, deviceId: req.get('x-device-id'), ip: req.ip })));
});

router.post('/refresh', validate(z.object({ refreshToken: z.string() })), (req, res) => {
  res.json(session(auth.refresh({ ...req.body, deviceId: req.get('x-device-id') })));
});

router.post('/logout', validate(z.object({ refreshToken: z.string() })), (req, res) => {
  auth.logout(req.body);
  res.json({ ok: true });
});

router.post('/password/forgot', validate(z.object({ identifier: z.string() })), (req, res) => {
  res.json({ ok: true, ...auth.requestPasswordReset(req.body) });
});

router.post('/password/reset', validate(z.object({ identifier: z.string(), code: z.string().length(6), newPassword: password })), (req, res) => {
  auth.resetPassword(req.body);
  res.json({ ok: true });
});

module.exports = router;
