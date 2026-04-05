-- Widen recurring transactions day_of_month constraint from 1-28 to 1-31
-- The cron logic will fire day > days_in_month on the last day of the month
ALTER TABLE recurring_transactions
  DROP CONSTRAINT recurring_transactions_day_of_month_check;

ALTER TABLE recurring_transactions
  ADD CONSTRAINT recurring_transactions_day_of_month_check
  CHECK (day_of_month BETWEEN 1 AND 31);
