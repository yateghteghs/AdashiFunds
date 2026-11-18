# Adashi App Development Document

This document specifies the AdashiFunds platform: its features, architecture and technical requirements. It also records what this repository implements today. Each feature section ends with a **Status** line:

- ✅ **Built**: implemented and covered by tests.
- 🟡 **Stand-in**: works end to end behind a provider interface, but uses a development stand-in that must be replaced with a real integration (and credentials) before launch.
- ⬜ **Roadmap**: not built yet.

---

## 1. Architecture

```
 ┌──────────────┐   ┌──────────────┐   ┌───────────────┐
 │ Web client   │   │ Mobile app   │   │ USSD gateway  │  (Africa's Talking / telco)
 │ (web/, Vue)  │   │ (roadmap: RN)│   │               │
 └──────┬───────┘   └──────┬───────┘   └──────┬────────┘
        │  JSON over HTTPS │                  │ form POST → CON/END text
        └────────┬─────────┴──────────────────┘
                 ▼
        ┌───────────────────────────────────────────────────────────┐
        │ Express API (src/routes)  auth · validation (zod) · rate   │
        │ limits · helmet/CSP · error mapping                        │
        ├───────────────────────────────────────────────────────────┤
        │ Services (src/services)                                    │
        │  auth/otp/kyc   wallet ─► ledger (double entry)            │
        │  groups (rotation engine) ◄─ scheduler (time-based rules)  │
        │  governance · loans · disputes · fraud · reputation        │
        │  notifications/notifier · statements · referrals · ussd    │
        │  audit (hash-chained log)                                  │
        ├──────────────────────────────┬────────────────────────────┤
        │ db (SQLite now; SQL is       │ payments/ (mock, paystack) │
        │ portable to PostgreSQL)      │ kyc providers (mock, manual)│
        └──────────────────────────────┴────────────────────────────┘
```

**Key design decisions**

1. **Money is integer kobo** everywhere, never floating point.
2. **Double-entry ledger.** Every movement of money is one `transactions` row plus `ledger_entries` that sum to zero. User, group-pot and group-reserve balances can never go negative. `GET /api/admin/ledger/reconcile` proves that cached balances equal the sum of entries and that the whole ledger nets to zero.
3. **Groups are state machines.** A group goes `forming → active → completed` (or is `cancelled`). Each member gets one round. Contributions are created when a round opens, so voted rule changes (for example a new contribution amount) apply only to future rounds.
4. **Rules are code.** The group engine and scheduler enforce due dates, grace periods, penalties, default handling and payouts. No admin can redirect a payout or skip the order.
5. **Tamper evidence without a blockchain.** `audit_log` is hash-chained: each record's SHA-256 covers its content and the previous hash, so editing or deleting history breaks verification. To add public verifiability later, anchor the head hash on a public chain or a timestamping service.
6. **Everything idempotent at the edges.** Deposit settlement and withdrawal completion can be called repeatedly (webhook retries, client polling) without double-crediting.

---

## 2. Core Features and Functionalities

### 2.1 User Registration & Authentication

Users create an account and verify their identity securely.

- **Sign-up/login** with phone number (normalised to E.164) or email, plus password (scrypt-hashed). ✅
- **Phone verification** by 6-digit SMS OTP. Codes are hashed at rest, single-use, expire after 10 minutes, allow 5 attempts, and are rate limited to 5 per hour. ✅
- **Two-factor authentication**: TOTP authenticator apps (RFC 6238) with SMS OTP fallback; the second step uses a short-lived MFA token. ✅
- **Sessions**: 15-minute JWT access tokens and 30-day refresh tokens that rotate on each use and are revoked on logout, password reset and suspension. ✅
- **Password reset** by OTP, without revealing whether an account exists. ✅
- **KYC**: NIN, BVN, passport, driver's licence or voter's card. ID numbers are AES-256-GCM encrypted; only the last 4 digits are shown. Verification raises the KYC tier (BVN gives tier 2), and the tier sets limits. Includes a manual review queue. 🟡 The mock provider auto-verifies; connect Smile Identity, VerifyMe, Prembly or similar in `src/services/kyc.js`.
- **Biometric login** (Face ID or fingerprint) unlocks the stored refresh token on the device. ⬜ Needs the mobile app.

### 2.2 Automated Savings & Payouts

The app automates contributions and payouts for Adashi groups.

- **Create or join groups** by invite code, or from public listings; members can be in multiple groups. ✅
- **Cycle**: daily, weekly or monthly, with a fixed contribution amount per group. The amount can be changed by vote for future rounds. ✅
- **Payout order**: join order, random draw (crypto-secure shuffle) or set by the admin. ✅
- **Auto-debit**: on the due date the scheduler debits the wallets of members with auto-debit on, and notifies anyone whose wallet is short. ✅ Direct debit from bank accounts or cards (card authorisations, mandates) is ⬜ roadmap; today users fund the wallet first.
- **Instant or scheduled payouts**: `when_complete` pays as soon as everyone has paid; `on_due_date` waits for the due date. ✅
- **Late payments**: paying after the due date plus the grace period adds a late penalty, which goes to the group reserve. ✅
- **Defaults**: when the grace period ends, the round settles and pays out what was collected. Unpaid contributions become defaults, which lower the member's trust score and alert the admin. When the defaulter pays later, the money goes straight to that round's recipient. ✅
- **Auto-withdraw**: payouts can be sent on to the member's default bank account automatically. ✅

### 2.3 Digital Wallet & Payment Integration

- **Balance and history**, showing the signed effect of each transaction on the wallet. ✅
- **Deposits** by card, bank transfer, USSD or mobile money through the payment provider, settled by webhook (HMAC-verified) or client verification. 🟡 The mock provider credits instantly. The Paystack adapter (`src/services/payments/paystack.js`) is written but has not been run against the live API; it needs `PAYSTACK_SECRET_KEY` and a sandbox test pass. A Flutterwave adapter is ⬜ roadmap.
- **Withdrawals** to bank accounts verified by account-name resolution. They require KYC tier 1+, are held in a clearing account while in flight, and are reversed automatically on failure. ✅ (with the provider caveat above)
- **Peer-to-peer transfers** by phone or email, with an optional flat fee. ✅
- **QR codes**: `adashi://pay?to=…&amount=…` payment codes. ✅ An in-app camera scanner is ⬜ roadmap.
- **Limits by KYC tier**: single withdrawal and 24-hour outflow limits. ✅

### 2.4 Rule Enforcement & Fraud Prevention

- **Group rules enforced by the engine** (the role the spec gives "smart contracts"). See design decisions 4–5. ✅ Ethereum/Hyperledger smart contracts are not used; see the white paper's design note.
- **Default protection**: missed payments are flagged, the admin is alerted, the trust score drops, and loan balances are recovered from payouts. ✅
- **Fraud detection**: a rule-based engine (`src/services/fraud.js`) checks transfer and withdrawal velocity, unusual amounts against the user's history, large withdrawals within 24 hours of sign-up, funds passed straight through, and devices shared across accounts. A score ≥ 80 blocks the transaction and alerts the user; a score ≥ 50 flags it for review. ✅ Reviewer decisions (`cleared` or `confirmed`) produce labelled data for a future ML model, which is ⬜ roadmap.
- **Dispute resolution**: categories, parties, a message thread, the linked transaction, and the audit trail as evidence. Decisions are made by a neutral group admin or a platform admin. ✅ AI-assisted arbitration is ⬜ roadmap.

### 2.5 Dashboard & Reporting

- **Home dashboard**: wallet balance, contributions due with one-tap pay, next payout, trust score, groups, recent activity, loans and a savings tip. ✅
- **Transaction history** and **statements** as JSON, CSV (protected against formula injection) and PDF, plus monthly summaries. ✅
- **Notifications**: in-app plus SMS for important events (reminders, payouts, defaults, loans, fraud alerts). 🟡 The SMS transport logs to the console; plug Termii or Africa's Talking into `src/services/notifier.js`. Push notifications are ⬜ roadmap (mobile app).

### 2.6 Group Management & Governance

- **Admin tools**: edit settings while the group is forming, set the payout order, start or cancel the group, settle an overdue round. ✅
- **Voting**: proposals for rule changes, loans and member removal. A proposal passes when YES votes exceed the group's threshold (default: a strict majority) of eligible voters, fails as soon as passing becomes impossible, and expires after 72 hours. Structural settings (frequency, size, payout order) cannot change after the start. ✅
- **Trust score** (0–100): an explainable score built from identity, on-time and late payments, defaults, completed groups and loan history, shown to group members. ✅
- **Group chat** with system event messages. ✅ It polls every 5 seconds; WebSockets are ⬜ roadmap.

### 2.7 Loans

- **Emergency loans** from the group reserve. They require KYC, allow one open loan per group, and use group-set interest and a 1–180 day term. Each loan is a governance proposal on which the borrower cannot vote. Repayment is from the wallet, and anything outstanding is recovered from the borrower's payout. Overdue loans trigger notifications and lower the trust score. ✅

### 2.8 Referral & Rewards Program

- **Referral codes and links**. Points (plus an optional wallet bonus) are awarded when the referred user makes their **first contribution**, not at sign-up, which discourages fake accounts. ✅
- **Leaderboards** for top savers (on-time contributions) and top referrers, showing masked names. ✅

### 2.9 Multi-Language & Localization

- **Languages**: English, Hausa, Yorùbá, Igbo, Pidgin and French, for server messages (notifications, USSD) and the UI, falling back to English per string. 🟡 English is complete. The other languages cover navigation, key actions and the main notifications, and are drafts that **must be reviewed by native speakers** before launch.
- **Display currency**: amounts are also shown converted to USD, GHS, XOF or KES at configured rates. ✅ Transacting in currencies other than NGN is ⬜ roadmap.
- **Offline / USSD**: an Africa's Talking-compatible USSD menu for balance, groups, PIN-protected contributions and next payout, with a lockout after wrong PINs. 🟡 Needs a USSD short code from a gateway provider.

### 2.10 Security & Compliance

- Encryption at rest for sensitive fields (AES-256-GCM); TLS must be terminated in front of the app. ✅
- Helmet security headers and a strict CSP, rate-limited auth endpoints, input validation on every endpoint, parameterised SQL only. ✅
- Production refuses to start without secrets, and refuses the mock payment provider. ✅
- **Audit trail**: logins, money movements, rule changes, votes, KYC, admin actions and webhooks, with integrity verification. ✅
- **Regulatory compliance** (CBN, NDIC, NDPR/NDPA data protection): ⬜ an organisational workstream. Holding customer funds needs a licensed partner or licence; the ledger and audit design support the reporting this will require.

### 2.11 Support

- An FAQ assistant answers common questions instantly and offers a support ticket when unsure. ✅ An LLM-backed assistant can replace `support.answer()` without changing the API.
- Financial literacy tips by language. ✅

---

## 3. Running in production

1. Use **PostgreSQL**. The schema in `src/db/schema.sql` is portable. Replace `src/db/index.js` with a `pg` pool exposing the same `get/all/run/insert/update/tx` helpers, and make the helpers async.
2. Set `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `PAYMENT_PROVIDER=paystack`, `PAYSTACK_SECRET_KEY` and `PUBLIC_BASE_URL`, and register `POST /api/webhooks/paystack` with Paystack.
3. Run **one** scheduler instance (`DISABLE_SCHEDULER=true` on the others), or call `POST /api/admin/scheduler/run` from a cron job.
4. Put the app behind HTTPS (load balancer or reverse proxy). `trust proxy` is enabled for correct client IPs.
5. Back up the database and keep `DATA_ENCRYPTION_KEY` in a secrets manager. Losing the key makes encrypted fields unreadable.

## 4. Development Roadmap & Timeline

| Phase | Activities | Timeline | Status |
|---|---|---|---|
| Phase 1 | Market research & feasibility study | Months 1–2 | — |
| Phase 2 | MVP: wallet, savings groups & payouts | Months 3–5 | Core MVP in this repository |
| Phase 3 | Beta testing, real payment/KYC/SMS providers, PostgreSQL, licensing & compliance | Months 6–7 | Next |
| Phase 4 | Public launch & marketing; React Native app with biometrics & push | Months 8–9 | |
| Phase 5 | Expansion: multi-currency, ML risk models, credit products, new markets | Month 10+ | |

## 5. Next Steps

- **Developers**: run Paystack sandbox tests; add the SMS and KYC provider adapters; port to PostgreSQL; build the React Native app on the same API.
- **UI/UX team**: run usability tests of the web client with traders and cooperatives; design the mobile flows.
- **Security and compliance team**: complete the licensing path and NDPA data-protection review; commission a penetration test before handling real money.
- **Language reviewers**: review the Hausa, Yorùbá, Igbo, Pidgin and French strings in `src/lib/i18n.js` and `web/i18n.js`.
