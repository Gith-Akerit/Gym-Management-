-- Somebody asking to work here, and the owner deciding.
--
-- Until now an account existed because an administrator made one. Opening the
-- door to self-signup without a gate would mean anybody who finds the address
-- can hand themselves a staff account, so a new account arrives asking rather
-- than working: it exists, it cannot sign in, and the owner turns it on and
-- says what it may do.
--
-- `approval` is a new column rather than two more values in `status`, which
-- already has a CHECK constraint. Widening a CHECK in SQLite means rebuilding
-- the table, and `users` is referenced by foreign keys from members, sessions,
-- audit_logs and the token tables -- a rebuild there is a great deal of risk
-- for a word. The two also mean different things and should not share a
-- column: `status` is "has this account been switched off", `approval` is "has
-- anybody agreed to it existing yet".
--
-- Everything already in the table defaults to approved, so every account the
-- gym is using today keeps working without being touched.
ALTER TABLE users ADD COLUMN approval TEXT NOT NULL DEFAULT 'approved'
  CHECK (approval IN ('pending', 'approved', 'rejected'));

-- What the person typed about themselves when they asked. Staff accounts have
-- had no name until now -- the owner reads an email address and guesses -- so
-- this is also the first time the approval screen can say who is asking.
ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';

-- The decision, kept so "who let this person in?" has an answer a year later.
-- The audit log has it too; this is what the screen reads.
ALTER TABLE users ADD COLUMN requested_at INTEGER;
ALTER TABLE users ADD COLUMN decided_at INTEGER;
ALTER TABLE users ADD COLUMN decided_by TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN reject_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX users_approval ON users(approval, requested_at DESC);

-- The same one-time token table now carries two kinds of link. A setup link is
-- issued at a terminal and lives a day; a reset link is asked for by whoever
-- is standing at the login screen and lives thirty minutes, because the person
-- who asked for it is waiting for it right now and a link that outlives that
-- moment is a link sitting in a mailbox somebody else may read.
ALTER TABLE password_setup_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'setup'
  CHECK (purpose IN ('setup', 'reset'));
