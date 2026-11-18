# AdashiFunds API

Base path: `/api`. Request and response bodies are JSON. **All amounts are integer kobo** (₦1 = 100).

Authenticated endpoints need `Authorization: Bearer <accessToken>`. Send `X-Device-Id: <stable id>` from each client; it is used for device-based fraud checks.

Errors look like this:

```json
{ "error": { "code": "insufficient_funds", "message": "Insufficient balance for this transaction" } }
```

## Auth (`/auth`)

| Method & path | Body | Notes |
|---|---|---|
| `POST /auth/register` | `fullName, phone, password, email?, referralCode?, language?` | Sends an SMS OTP. Returns `devOtp` in development. |
| `POST /auth/verify-phone` | `phone, code` | Returns `{ user, accessToken, refreshToken }`. |
| `POST /auth/resend-verification` | `phone` | |
| `POST /auth/login` | `identifier` (phone or email), `password` | Returns a session, or `{ mfaRequired, mfaToken }`. |
| `POST /auth/mfa/sms` | `mfaToken` | Sends an SMS code as the second factor. |
| `POST /auth/mfa/verify` | `mfaToken, code, method?` (`totp` or `sms`) | Returns a session. |
| `POST /auth/refresh` | `refreshToken` | Rotates the refresh token. |
| `POST /auth/logout` | `refreshToken` | |
| `POST /auth/password/forgot` | `identifier` | |
| `POST /auth/password/reset` | `identifier, code, newPassword` | Revokes all sessions. |

## Me (`/me`)

| Method & path | Notes |
|---|---|
| `GET /me` | Profile, trust score and current limits. |
| `PATCH /me` | `fullName?, language?, displayCurrency?, autoWithdraw?` |
| `GET /me/dashboard` | Wallet, groups, contributions due, next payout, recent transactions, trust score, loans. |
| `POST /me/password` | `currentPassword, newPassword` |
| `POST /me/mfa/setup` → `POST /me/mfa/enable` `{code}` | TOTP enrolment. |
| `POST /me/mfa/disable` | `password, code` |
| `POST /me/ussd-pin` | `password, pin` (4 digits) |
| `GET /me/kyc`, `POST /me/kyc` | `idType` (`NIN`, `BVN`, `PASSPORT`, `DRIVERS_LICENSE`, `VOTERS_CARD`), `idNumber`, `dateOfBirth?` |
| `GET /me/trust-score` | The score with every component explained. |
| `GET /me/referrals` | Referral code, link, points and the people you referred. |
| `GET /me/loans` | |

## Wallet (`/wallet`)

| Method & path | Notes |
|---|---|
| `GET /wallet` | Balance. |
| `GET /wallet/transactions?limit&offset&type` | Each row has `net`, the signed effect on your wallet. |
| `POST /wallet/deposits` | `amount, channel?` (`card`, `bank_transfer`, `ussd`, `mobile_money`). May return an `authorizationUrl` to redirect to. |
| `GET /wallet/deposits/:reference/verify` | Polls the provider and settles the deposit. |
| `POST /wallet/withdrawals` | `amount, bankAccountId?` Requires KYC. |
| `POST /wallet/transfers` | `amount` plus `recipient` (phone or email) or `recipientId`, `note?` |
| `GET /wallet/banks` | Banks and mobile-money providers. |
| `GET/POST/DELETE /wallet/bank-accounts[/:id]` | `bankCode, accountNumber`. The account name is resolved with the provider. |
| `GET /wallet/qr?amount` | `{ payload, dataUrl }` |
| `GET /wallet/statement?month=YYYY-MM&format=json\|csv\|pdf` | Or use `from` and `to` instead of `month`. |
| `GET /wallet/summary?month=YYYY-MM` | |

## Groups (`/groups`)

| Method & path | Notes |
|---|---|
| `GET /groups` | Your groups. |
| `GET /groups/public` | Public groups that are still forming. |
| `POST /groups` | `name, contributionAmount, frequency, maxMembers`, plus optional `description, payoutOrder, payoutTiming, latePenaltyBps, gracePeriodHours, loanInterestBps, approvalThresholdBps, isPublic, requireKyc` |
| `POST /groups/join` | `inviteCode`, or `groupId` for a public group. |
| `GET /groups/:id` | Full detail: members, rounds and each contribution's status and penalty. |
| `PATCH /groups/:id` | Admin only, while forming. |
| `PUT /groups/:id/payout-order` | `userIds[]` (admin, while forming). |
| `POST /groups/:id/start` | `firstDueAt?` (admin). |
| `POST /groups/:id/leave`, `POST /groups/:id/cancel` | Only while forming. |
| `PUT /groups/:id/auto-debit` | `enabled` |
| `POST /groups/:id/contributions` | `contributionId?` (defaults to your oldest outstanding contribution). |
| `POST /groups/:id/close-round` | Admin; only after the grace period ends. |
| `GET/POST /groups/:id/messages` | Group chat (`body`; `?after=` timestamp to fetch newer messages). |
| `GET/POST /groups/:id/proposals` | `type` (`rule_change` or `remove_member`), `title`, `payload` (`{changes}` or `{userId}`). |
| `GET/POST /groups/:id/loans` | `amount, termDays?, reason?` Creates a loan vote. |
| `POST /groups/:id/reserve` | `amount`: a voluntary top-up of the loan reserve. |

## Governance, loans, disputes and more

| Method & path | Notes |
|---|---|
| `GET /proposals/:id` | |
| `POST /proposals/:id/votes` | `choice` (`yes` or `no`) |
| `POST /loans/:id/repayments` | `amount?` (defaults to the full outstanding amount). |
| `GET/POST /disputes` | `category, description, groupId?, againstUserId?, transactionId?` |
| `GET /disputes/:id` | Includes messages and audit evidence. |
| `POST /disputes/:id/messages` | `body, evidenceRef?` |
| `POST /disputes/:id/status` | `status` (`under_review`, `resolved` or `rejected`), `resolution` |
| `GET /notifications?unread=true`, `POST /notifications/read` | `ids?` (omit to mark all as read). |
| `GET /leaderboard` | |
| `POST /support/assistant` | `question` |
| `GET/POST /support/tickets` | `subject, body` |
| `GET /content/tips?lang` | |
| `GET /meta`, `GET /health` | Public. |

## Admin (`/admin`, platform admins only)

`GET /admin/stats` · `GET /admin/fraud-flags?status` · `POST /admin/fraud-flags/:id` `{status: cleared|confirmed}` · `GET /admin/kyc/pending` · `POST /admin/kyc/:id/review` `{status, reason?}` · `POST /admin/users/:id/status` `{status: active|suspended}` · `GET /admin/audit` · `GET /admin/audit/verify` · `GET /admin/ledger/reconcile` · `POST /admin/scheduler/run`

## Integrations (no auth)

- `POST /webhooks/:provider`: payment provider webhooks. The raw body is HMAC-verified (Paystack: `x-paystack-signature`).
- `POST /ussd`: Africa's Talking USSD callback (`sessionId, serviceCode, phoneNumber, text`, form-encoded). Responds with plain text `CON …` to continue the session or `END …` to end it.
