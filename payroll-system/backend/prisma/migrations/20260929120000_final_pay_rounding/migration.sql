-- Additive only. Historical payroll and payslip snapshots are deliberately not
-- backfilled or rewritten; NULL identifies rows created before final-pay
-- rounding became authoritative.
ALTER TABLE `payroll_employees`
  ADD COLUMN `net_salary_before_rounding` DECIMAL(15,2) NULL AFTER `total_deduction`,
  ADD COLUMN `rounding_adjustment` DECIMAL(15,2) NULL AFTER `net_salary_before_rounding`;
