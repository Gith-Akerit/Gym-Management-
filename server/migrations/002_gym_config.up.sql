-- Gym profile: single row (id=1). Every business fact the reporter has not
-- confirmed yet stays NULL and is edited in the admin console, never hardcoded.
CREATE TABLE gym_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  brand_name_th TEXT NOT NULL DEFAULT '',
  address TEXT,
  location_note TEXT,
  phone_primary TEXT,
  phone_secondary TEXT,
  phone_display TEXT NOT NULL DEFAULT 'primary' CHECK (phone_display IN ('primary','secondary','hidden')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
  currency TEXT NOT NULL DEFAULT 'THB',
  hours_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (hours_confirmed IN (0,1)),
  hours_note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
) STRICT;

-- weekday follows Date#getDay(): 0 = Sunday .. 6 = Saturday.
CREATE TABLE gym_hours (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
  open_time TEXT CHECK (open_time IS NULL OR open_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  close_time TEXT CHECK (close_time IS NULL OR close_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  updated_at INTEGER NOT NULL,
  CHECK (closed = 1 OR (open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time))
) STRICT;

-- price_satang is nullable on purpose: seeded packages are drafts until the
-- reporter fills in real prices from the admin console (Planner seed JSON).
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_th TEXT NOT NULL CHECK (length(name_th) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK (type IN ('unlimited','limited_sessions')),
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 3650),
  session_limit INTEGER CHECK (session_limit IS NULL OR session_limit BETWEEN 1 AND 1000),
  price_satang INTEGER CHECK (price_satang IS NULL OR (price_satang BETWEEN 0 AND 100000000)),
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Every package expires (reporter requirement); only limited_sessions counts visits.
  CHECK ((type = 'limited_sessions' AND session_limit IS NOT NULL)
      OR (type = 'unlimited' AND session_limit IS NULL))
) STRICT;
CREATE INDEX packages_status ON packages(status, sort_order);

-- Per-address OTP lockout. The per-challenge attempt cap alone lets an attacker
-- keep requesting fresh challenges; this bounds guesses across all of them.
CREATE TABLE otp_lockouts (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  failures INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

ALTER TABLE audit_logs ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'member';
