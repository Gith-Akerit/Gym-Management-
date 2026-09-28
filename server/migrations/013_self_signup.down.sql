DROP INDEX users_approval;
ALTER TABLE users DROP COLUMN approval;
ALTER TABLE users DROP COLUMN name;
ALTER TABLE users DROP COLUMN phone;
ALTER TABLE users DROP COLUMN requested_at;
ALTER TABLE users DROP COLUMN decided_at;
ALTER TABLE users DROP COLUMN decided_by;
ALTER TABLE users DROP COLUMN reject_reason;
ALTER TABLE password_setup_tokens DROP COLUMN purpose;
