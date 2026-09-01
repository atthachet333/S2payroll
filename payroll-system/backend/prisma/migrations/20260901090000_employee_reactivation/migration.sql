-- Additive only. One nullable column; every existing row keeps NULL, which the
-- eligibility rules read as "never deactivated", reproducing today's behaviour
-- exactly.
ALTER TABLE `employees`
    ADD COLUMN `reactivated_at` DATE NULL;
