-- Going back to the version where every member had a login.
--
-- Members signed up at the counter have no account, and the old table refuses a
-- row without one. Rather than drop those people, each gets a placeholder
-- account on an address that can never receive mail (.invalid is reserved for
-- exactly this) and no password, so it opens nothing.
INSERT INTO users (id, email, role, created_at)
  SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
    || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2)
    || '-' || lower(hex(randomblob(6))),
    'member-' || m.id || '@counter.invalid', 'member', m.joined_at
  FROM members m WHERE m.user_id IS NULL;
UPDATE members SET user_id = (SELECT u.id FROM users u WHERE u.email='member-' || members.id || '@counter.invalid')
  WHERE user_id IS NULL;

CREATE TABLE members_old (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  member_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  phone TEXT NOT NULL UNIQUE,
  date_of_birth TEXT,
  emergency_contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','expired')),
  version INTEGER NOT NULL DEFAULT 1,
  joined_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
INSERT INTO members_old SELECT id,user_id,member_code,name,phone,date_of_birth,emergency_contact,
  status,version,joined_at,updated_at FROM members;
DROP TABLE members;
ALTER TABLE members_old RENAME TO members;
CREATE INDEX members_status ON members(status);
CREATE INDEX members_name ON members(name);

ALTER TABLE orders DROP COLUMN payment_method;
ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN password_set_at;
