-- The confirmation SLA is a promise shown to members, and the owner has not
-- agreed to one yet, so it lives here as editable text rather than in the code.
ALTER TABLE gym_profile ADD COLUMN payment_sla_text TEXT NOT NULL DEFAULT 'ภายใน 30 นาทีในเวลาทำการ';
ALTER TABLE gym_profile ADD COLUMN order_ttl_minutes INTEGER NOT NULL DEFAULT 60;

-- Every package detail is snapshotted onto the order. Editing a package later
-- must never rewrite what somebody already agreed to pay.
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  package_code_snapshot TEXT NOT NULL,
  package_name_snapshot TEXT NOT NULL,
  package_type_snapshot TEXT NOT NULL CHECK (package_type_snapshot IN ('unlimited','limited_sessions')),
  duration_days_snapshot INTEGER NOT NULL CHECK (duration_days_snapshot BETWEEN 1 AND 3650),
  session_limit_snapshot INTEGER CHECK (session_limit_snapshot IS NULL OR session_limit_snapshot BETWEEN 1 AND 1000),
  price_satang_snapshot INTEGER NOT NULL CHECK (price_satang_snapshot BETWEEN 0 AND 100000000),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','awaiting_review','paid','rejected','expired','cancelled')),
  rejection_reason TEXT,
  review_note TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX orders_member ON orders(member_id, created_at);
CREATE INDEX orders_status ON orders(status, created_at);

-- Slips carry the payer's name, part of their account number and the amount, so
-- the bytes live outside the web root and are only ever served through an
-- authenticated endpoint. Only the metadata is kept here.
CREATE TABLE payment_slips (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  stored_name TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  file_hash TEXT NOT NULL,
  reference_no TEXT NOT NULL,
  transferred_at INTEGER NOT NULL,
  amount_satang_claimed INTEGER CHECK (amount_satang_claimed IS NULL OR amount_satang_claimed >= 0),
  superseded_at INTEGER,
  uploaded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX slips_order ON payment_slips(order_id, uploaded_at);
-- Reusing one transfer for two orders is the cheapest fraud there is; these two
-- indexes are what make the duplicate check fast enough to run on every upload.
CREATE INDEX slips_hash ON payment_slips(file_hash);
CREATE INDEX slips_reference ON payment_slips(reference_no);

-- order_id is UNIQUE on purpose. A double-clicked approve button or two admins
-- approving at once cannot create a second entitlement even if the application
-- logic above were wrong: the database refuses the row.
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sessions_total INTEGER CHECK (sessions_total IS NULL OR sessions_total > 0),
  sessions_remaining INTEGER CHECK (sessions_remaining IS NULL OR sessions_remaining >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_at INTEGER NOT NULL,
  -- Unlimited packages count no sessions; limited ones always do. Both expire.
  CHECK ((sessions_total IS NULL) = (sessions_remaining IS NULL))
) STRICT;
-- Phase 3 picks the entitlement that expires soonest, which is exactly this index.
CREATE INDEX entitlements_member ON entitlements(member_id, status, expires_at);
