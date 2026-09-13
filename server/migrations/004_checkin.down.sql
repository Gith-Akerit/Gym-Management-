DROP INDEX check_ins_time;
DROP INDEX check_ins_member;
DROP TABLE check_ins;
DROP INDEX check_in_tokens_member;
DROP TABLE check_in_tokens;
ALTER TABLE gym_profile DROP COLUMN check_in_token_seconds;
ALTER TABLE gym_profile DROP COLUMN check_in_window_minutes;
