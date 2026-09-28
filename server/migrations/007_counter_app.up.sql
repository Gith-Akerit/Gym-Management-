-- The gym becomes a counter application.
--
-- Members no longer sign in: there is no member app, no member mailbox and no
-- member password. What a member holds is a picture of a card in a chat app.
-- Staff and the owner sign in with an email and a password, so the system stops
-- depending on a mail provider being reachable at the moment somebody needs to
-- open the till.
--
-- Nothing is deleted here. Every member, entitlement, order, slip and check-in
-- that exists keeps its row and its identity.

-- ---------------------------------------------------------------- staff login
-- NULL means "this account cannot sign in yet". Every member row carried over
-- from the old system lands there, which is exactly right: members do not.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_set_at INTEGER;

-- ------------------------------------------------------------- member records
-- user_id becomes optional. Somebody signed up at the counter has a name, a
-- phone number and a photograph, and no account at all -- there is nothing for
-- an account to do. SQLite cannot relax NOT NULL in place, so the table is
-- rebuilt; migrate() runs this with foreign keys off and checks them after.
CREATE TABLE members_new (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id),
  member_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  phone TEXT NOT NULL UNIQUE,
  date_of_birth TEXT,
  emergency_contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','expired')),
  -- The photograph is the only thing that tells the person at the counter that
  -- the card belongs to whoever is holding it. Bytes live outside the web root
  -- like a slip; only the name of the file is here.
  photo_stored_name TEXT,
  photo_content_type TEXT,
  photo_updated_at INTEGER,
  -- The QR on the card never changes and never expires, so a lost card is
  -- cancelled by counting past it rather than by finding it.
  card_version INTEGER NOT NULL DEFAULT 1 CHECK (card_version > 0),
  card_issued_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO members_new (id,user_id,member_code,name,phone,date_of_birth,emergency_contact,status,
  card_version,version,joined_at,updated_at)
  SELECT id,user_id,member_code,name,phone,date_of_birth,emergency_contact,status,
    1,version,joined_at,updated_at FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_status ON members(status);
CREATE INDEX members_name ON members(name);
CREATE INDEX members_card ON members(card_version);

-- --------------------------------------------------------- money at the counter
-- How the gym was actually paid. Orders that already exist were paid by
-- PromptPay through the member app, except the ones an admin handed over, which
-- were never paid at all.
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'promptpay'
  CHECK (payment_method IN ('promptpay','cash','transfer','none'));
UPDATE orders SET payment_method='none' WHERE manual_grant=1;
