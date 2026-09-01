-- Additive only. Two derived DAILY figures recorded alongside the payroll row
-- so a payslip can explain how worked time became paid time. Existing rows
-- default to 0, which reads as "no break, nothing derived" - exactly what was
-- true before the rule existed. No stored attendance minute is altered.
ALTER TABLE `payroll_employees`
    ADD COLUMN `break_deduction_minutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `payable_minutes` INTEGER NOT NULL DEFAULT 0;
