-- Whether an account may sign in at all.
--
-- Distinct from members.status, which is about a membership: a member can be
-- suspended at the gym while their login still works, and a staff account has
-- no membership to suspend. Turning off somebody's access -- a phone that
-- walked away, a person who left -- had no home before this.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended'));
