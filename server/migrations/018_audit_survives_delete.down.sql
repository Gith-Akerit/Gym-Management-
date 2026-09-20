-- Back to a foreign key with no ON DELETE. Rows whose account was deleted while
-- 018 was in place point at the placeholder, which still exists as a user, so
-- nothing dangles -- but deleting an account becomes impossible again.
DROP INDEX IF EXISTS audit_time;
DROP INDEX IF EXISTS audit_actor;
DROP INDEX IF EXISTS orders_paid;

CREATE TABLE audit_logs_old (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at INTEGER NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'member'
) STRICT;
INSERT INTO audit_logs_old SELECT id, actor_id, action, entity_id, before_json, after_json, created_at, entity_type FROM audit_logs;
DROP TABLE audit_logs;
ALTER TABLE audit_logs_old RENAME TO audit_logs;
CREATE INDEX audit_entity ON audit_logs(entity_id, created_at);
