-- AdashiFunds schema. Written in portable SQL (SQLite for dev/test; maps 1:1 to PostgreSQL).
-- Money columns are INTEGER kobo. Timestamps are ISO-8601 UTC strings.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'none',          -- none | pending | verified | rejected
  kyc_tier INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',                -- user | admin
  status TEXT NOT NULL DEFAULT 'active',            -- active | suspended
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT REFERENCES users(id),
  referral_points INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL DEFAULT 'en',
  display_currency TEXT NOT NULL DEFAULT 'NGN',
  ussd_pin_hash TEXT,
  auto_withdraw INTEGER NOT NULL DEFAULT 0,
  default_bank_account_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL,                            -- verify_phone | login | reset_password | mfa
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otp_lookup ON otp_codes(destination, purpose);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (device_id, user_id)
);

CREATE TABLE IF NOT EXISTS kyc_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  id_type TEXT NOT NULL,                            -- NIN | BVN | PASSPORT | DRIVERS_LICENSE | VOTERS_CARD
  id_number_enc TEXT NOT NULL,
  id_last4 TEXT NOT NULL,
  date_of_birth TEXT,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL,                             -- pending | verified | rejected
  reason TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number_enc TEXT NOT NULL,
  account_last4 TEXT NOT NULL,
  account_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Ledger: every balance lives in an account; every movement is a balanced set of entries.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,                         -- user | group_pot | group_reserve | system
  owner_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  balance INTEGER NOT NULL DEFAULT 0,
  allow_negative INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,     -- deposit | withdrawal | transfer | contribution | payout | penalty | fee | loan_disbursement | loan_repayment | referral_bonus | reversal
  status TEXT NOT NULL,   -- pending | success | failed | reversed
  amount INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  user_id TEXT REFERENCES users(id),
  counterparty_user_id TEXT REFERENCES users(id),
  group_id TEXT,
  description TEXT,
  provider TEXT,
  provider_ref TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_counterparty ON transactions(counterparty_user_id, created_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL,                          -- signed: + credit, - debit
  balance_after INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_account ON ledger_entries(account_id, created_at);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  admin_id TEXT NOT NULL REFERENCES users(id),
  contribution_amount INTEGER NOT NULL,
  frequency TEXT NOT NULL,                          -- daily | weekly | monthly
  max_members INTEGER NOT NULL,
  payout_order TEXT NOT NULL DEFAULT 'join_order',  -- join_order | random | manual
  late_penalty_bps INTEGER NOT NULL DEFAULT 500,
  grace_period_hours INTEGER NOT NULL DEFAULT 24,
  loan_interest_bps INTEGER NOT NULL DEFAULT 500,
  approval_threshold_bps INTEGER NOT NULL DEFAULT 5001, -- share of eligible voters needed to pass
  payout_timing TEXT NOT NULL DEFAULT 'when_complete', -- when_complete (instant once all paid) | on_due_date
  is_public INTEGER NOT NULL DEFAULT 0,
  require_kyc INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'forming',           -- forming | active | completed | cancelled
  current_round INTEGER NOT NULL DEFAULT 0,
  start_at TEXT,
  pot_account_id TEXT NOT NULL REFERENCES accounts(id),
  reserve_account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',              -- admin | member
  payout_position INTEGER,
  auto_debit INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',            -- active | left | removed
  joined_at TEXT NOT NULL,
  UNIQUE (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  round_number INTEGER NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',         -- scheduled | open | paid_out
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  payout_amount INTEGER,
  payout_transaction_id TEXT,
  paid_out_at TEXT,
  UNIQUE (group_id, round_number)
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  penalty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | paid | defaulted
  paid_on_time INTEGER,
  defaulted_at TEXT,                                -- set if the round paid out without this contribution
  auto_debit_attempted_at TEXT,
  late_notified INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  transaction_id TEXT,
  UNIQUE (round_id, user_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  proposer_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                               -- rule_change | loan | remove_member
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',              -- open | passed | rejected | expired
  threshold_bps INTEGER NOT NULL,
  excluded_user_id TEXT,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  choice TEXT NOT NULL,                             -- yes | no
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  borrower_id TEXT NOT NULL REFERENCES users(id),
  proposal_id TEXT REFERENCES proposals(id),
  principal INTEGER NOT NULL,
  interest_bps INTEGER NOT NULL,
  total_due INTEGER NOT NULL,
  amount_repaid INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  term_days INTEGER NOT NULL,
  status TEXT NOT NULL,                             -- pending_vote | rejected | disbursed | repaid | overdue
  due_at TEXT,
  disbursed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES groups(id),
  raised_by TEXT NOT NULL REFERENCES users(id),
  against_user_id TEXT REFERENCES users(id),
  transaction_id TEXT REFERENCES transactions(id),
  category TEXT NOT NULL,                           -- missed_payout | wrong_amount | member_default | fraud | other
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',              -- open | under_review | resolved | rejected
  resolution TEXT,
  resolved_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS dispute_messages (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL REFERENCES disputes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  evidence_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  user_id TEXT REFERENCES users(id),               -- NULL for system messages
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS fraud_flags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  transaction_id TEXT,
  rule TEXT NOT NULL,
  score INTEGER NOT NULL,
  details TEXT,
  action TEXT NOT NULL,                             -- flagged | blocked
  status TEXT NOT NULL DEFAULT 'open',              -- open | cleared | confirmed
  created_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT
);

-- Tamper-evident audit trail: each row's hash covers its content and the previous row's hash.
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  data TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL DEFAULT 'in_app',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
