-- A membership the gym handed over directly: no transfer, no slip, no QR.
--
-- It is a real membership and behaves like one everywhere -- it expires, it
-- counts down sessions, it opens the door. What it is not is money the gym
-- received, so the daily total that gets reconciled against the bank statement
-- has to be able to leave it out. Without this column the two would silently
-- disagree and the gym would spend an evening looking for a transfer that never
-- existed.
ALTER TABLE orders ADD COLUMN manual_grant INTEGER NOT NULL DEFAULT 0;
