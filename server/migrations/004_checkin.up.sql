-- How long after a successful check-in a second scan is treated as the same
-- visit rather than a new one. Editable, because only the gym knows its own
-- rhythm; hardcoding it would make a staff correction impossible.
ALTER TABLE gym_profile ADD COLUMN check_in_window_minutes INTEGER NOT NULL DEFAULT 5;
-- How long a member's QR stays valid. Short enough that a screenshot passed to a
-- friend is useless, long enough to walk from the door to the counter.
ALTER TABLE gym_profile ADD COLUMN check_in_token_seconds INTEGER NOT NULL DEFAULT 60;

-- One row per QR the member's screen has shown. The QR itself carries only this
-- row's id and a signature — no name, no member code, nothing readable. Storing
-- the row is what makes "used exactly once" enforceable rather than hoped for.
CREATE TABLE check_in_tokens (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by TEXT REFERENCES users(id)
) STRICT;
CREATE INDEX check_in_tokens_member ON check_in_tokens(member_id, expires_at);

-- Refused attempts are recorded too: a member turned away at the counter is
-- exactly the case somebody will ask about later.
CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id),
  entitlement_id TEXT REFERENCES entitlements(id),
  token_id TEXT REFERENCES check_in_tokens(id),
  result TEXT NOT NULL CHECK (result IN ('allowed','duplicate','denied')),
  failure_reason TEXT,
  method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr')),
  device_label TEXT NOT NULL DEFAULT '',
  scanned_by TEXT REFERENCES users(id),
  checked_in_at INTEGER NOT NULL
) STRICT;
CREATE INDEX check_ins_member ON check_ins(member_id, checked_in_at);
CREATE INDEX check_ins_time ON check_ins(checked_in_at);
