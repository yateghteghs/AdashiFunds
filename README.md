# AdashiFunds

A digital platform for **Adashi** (also Adashe, Esusu, Ajo): the rotating savings and credit associations (ROSCAs) used by millions of people across Nigeria and West Africa.

Members put the same amount into a shared pot every period. Each period, one member takes the whole pot. AdashiFunds handles the parts that usually go wrong in cash-based groups. It collects contributions from secure wallets, pays out automatically in the agreed order, enforces the group's rules, and keeps a tamper-evident record of every naira.

## What's in this MVP

| Area | What works today |
|---|---|
| **Accounts & security** | Phone/email sign-up with SMS OTP, scrypt password hashing, JWT access tokens with rotating refresh tokens, TOTP two-factor auth (authenticator app) with SMS fallback, password reset, KYC (NIN, BVN, passport, driver's licence, voter's card) with tiered limits, AES-256-GCM encryption of ID and bank numbers at rest |
| **Groups** | Create/join by invite code or public listing, daily/weekly/monthly cycles, payout order by join order, random draw or admin-set, optional KYC-only groups, settings that lock once the group starts |
| **Contributions & payouts** | Pay from your wallet, auto-debit on the due date, reminders 24h ahead, grace period then late penalty, automatic payout (instantly when everyone has paid, or on the due date), default handling with later recovery straight to the round's recipient |
| **Wallet** | Double-entry ledger, deposits (card, bank transfer, USSD, mobile money via payment provider), withdrawals to verified bank accounts, peer-to-peer transfers by phone/email, QR payment codes, auto-withdraw of payouts, CSV and PDF statements, monthly summaries |
| **Loans** | Emergency loans from the group reserve (funded by penalties, interest and top-ups), approved by member vote, repaid from wallet, with automatic recovery from the borrower's next payout |
| **Governance** | Proposals and voting for rule changes, loans and member removal, with a configurable majority threshold and 72-hour expiry |
| **Transparency** | Real-time transaction history, group rotation timeline, hash-chained audit log with integrity verification, ledger reconciliation |
| **Risk** | Rule-based fraud engine (velocity, unusual amounts, new-account withdrawals, pass-through funds, shared devices) that blocks or flags for review |
| **Disputes** | Structured disputes with categories, parties, messages, linked transactions and the audit trail as evidence; decided by a neutral group admin or platform admin |
| **Engagement** | Group chat, in-app and SMS notifications, trust score (0–100, fully explained), referral codes and points, leaderboards, savings tips, FAQ assistant with ticket hand-off |
| **Reach** | USSD menu for feature phones (balance, groups, PIN-protected contributions), six languages (English, Hausa, Yorùbá, Igbo, Pidgin, French), display-currency conversion |
| **Back office** | Platform stats, fraud-flag review, KYC review queue, user suspension, audit-chain verification, ledger reconciliation |

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for which spec items are complete, which use a stand-in (for example mock payment and KYC providers), and which are still roadmap.

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
npm run seed
```

```bash
npm start
```

Open http://localhost:3000. The seed creates demo accounts (password `passw0rd1`):

| Phone | Who |
|---|---|
| `08000000001` | Platform admin (back office) |
| `08030000001` | Amina, admin of *Balogun Market Traders* (round 1 recipient) |
| `08030000005` | Efe, who still owes round 1 (fund the wallet, then pay) |

In development the payment provider is a **mock** that credits deposits instantly. OTP codes are shown on screen and printed to the server log in place of SMS.

## Tests

```bash
npm test
```

35 integration tests cover auth/MFA/OTP, wallet and ledger integrity, full group rotations, scheduler-driven auto-debit, penalties and defaults (with simulated time), governance, loans with payout recovery, disputes, referrals, USSD, fraud blocking, webhook signatures and audit-log tamper detection.

## Configuration

Copy `.env.example` and set values. In `NODE_ENV=production` the server refuses to start without `JWT_SECRET` and `DATA_ENCRYPTION_KEY`, and refuses the mock payment provider.

## Project layout

```
src/
  app.js, server.js        Express app and process entry
  config.js                Environment configuration and limits
  db/                      Schema (portable SQL) and SQLite access layer
  lib/                     crypto (hashing, AES-GCM, TOTP), i18n, money, errors, clock
  services/                Business logic: auth, wallet, ledger, groups, governance, loans,
                           disputes, fraud, kyc, audit, scheduler, statements, ussd, payments/
  routes/                  HTTP API
web/                       Responsive web client (Vue 3, no build step)
test/                      node:test + supertest integration tests
docs/                      White paper, development document, API reference
scripts/seed.js            Demo data
```

## Documentation

- [White paper](docs/WHITEPAPER.md): the problem, the solution, the business model and the roadmap
- [Development document](docs/DEVELOPMENT.md): feature specification, architecture and implementation status
- [API reference](docs/API.md)
