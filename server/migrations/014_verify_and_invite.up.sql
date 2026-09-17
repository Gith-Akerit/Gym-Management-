-- A third kind of one-time link, and a lock on the public sign-up form.
--
-- The token table is rebuilt rather than altered because its CHECK has to
-- learn a third value, and SQLite cannot widen a CHECK in place. Rebuilding is
-- safe HERE and was not safe for `users`: nothing in the schema references
-- this table, it holds at most a handful of live rows, and every row in it is
-- a link that is about to expire anyway.
CREATE TABLE password_setup_tokens_new (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  issued_by TEXT REFERENCES users(id),
  -- setup: issued at a terminal, a day, for an account with no password.
  -- reset: asked for at the login screen, thirty minutes, because the person
  --        who asked is waiting for it right now.
  -- verify: proves the address in a sign-up is reachable by whoever typed it.
  purpose TEXT NOT NULL DEFAULT 'setup' CHECK (purpose IN ('setup', 'reset', 'verify'))
) STRICT;
INSERT INTO password_setup_tokens_new
  SELECT token_hash, user_id, created_at, expires_at, used_at, issued_by, purpose
  FROM password_setup_tokens;
DROP TABLE password_setup_tokens;
ALTER TABLE password_setup_tokens_new RENAME TO password_setup_tokens;
CREATE INDEX password_setup_user ON password_setup_tokens(user_id, expires_at);

-- When the address was proved. Approving somebody whose address has never
-- answered means the "you are in" letter goes nowhere and nobody finds out
-- until they telephone.
ALTER TABLE users ADD COLUMN email_verified_by_link_at INTEGER;

-- The gym's own invite code, optional.
--
-- The sign-up form lives on a public URL, which means anybody on the internet
-- can put a request in the owner's queue. One afternoon of that and the real
-- request is buried. With a code set, the form still exists and anybody with
-- the code still signs themselves up -- the queue just stops being open to the
-- whole internet (Designer). Empty means off, which is how every gym starts.
ALTER TABLE gym_settings ADD COLUMN invite_code TEXT NOT NULL DEFAULT '';
