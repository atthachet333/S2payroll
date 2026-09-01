-- Additive only. Five derived figures recorded next to the payroll row so the
-- calculation can be explained without re-deriving it. Existing rows default to
-- 0, which reads as "not yet derived" - true of anything calculated before the
-- company rounding policy existed. No stored punch or attendance minute changes.
ALTER TABLE `payroll_employees`
    ADD COLUMN `rounded_away_minutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `rounded_late_minutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `early_leave_minutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `rounded_early_leave_minutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `actual_ot_minutes` INTEGER NOT NULL DEFAULT 0;
