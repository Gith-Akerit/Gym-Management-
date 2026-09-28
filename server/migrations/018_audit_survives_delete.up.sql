-- An account can be deleted; what it did stays written down.
--
-- `audit_logs.actor_id` was `TEXT NOT NULL REFERENCES users(id)` with no
-- `ON DELETE` clause, which does not mean "the log rows disappear" -- it means
-- the database refuses to delete the account at all. Infra hit exactly that
-- clearing the QA accounts: the audit rows had to be deleted first, which is
-- the wrong way round. The trail is the thing that should survive.
--
-- SQLite cannot alter a foreign key in place, so the table is rebuilt. Nothing
-- else about it changes: same columns, same types, same index.

-- The row every deleted account's history points at afterwards. Suspended and
-- with no password hash, so it is an account nobody can ever sign in as -- it
-- exists to be a destination, not a login.
INSERT INTO users (id, email, role, status, created_at, name)
SELECT 'deleted-user', 'deleted@local', 'staff', 'suspended',
       (SELECT COALESCE(MIN(created_at), 0) FROM users), 'บัญชีที่ถูกลบ'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = 'deleted-user');

CREATE TABLE audit_logs_new (
  id TEXT PRIMARY KEY,
  -- The whole point of this migration: deleting the account moves its rows to
  -- the placeholder rather than refusing the delete.
  actor_id TEXT NOT NULL DEFAULT 'deleted-user' REFERENCES users(id) ON DELETE SET DEFAULT,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'member'
) STRICT;

INSERT INTO audit_logs_new (id, actor_id, action, entity_id, before_json, after_json, created_at, entity_type)
SELECT id, actor_id, action, entity_id, before_json, after_json, created_at, entity_type FROM audit_logs;

DROP TABLE audit_logs;
ALTER TABLE audit_logs_new RENAME TO audit_logs;

CREATE INDEX audit_entity ON audit_logs(entity_id, created_at);
-- The three the reports lean on. Every report filters by a date range, the
-- staff-activity one also by account, and the sales one reads orders by status
-- and the moment the money was taken.
CREATE INDEX IF NOT EXISTS audit_time  ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS orders_paid ON orders(status, reviewed_at);
