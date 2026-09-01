-- Additive only. No column is dropped, no value is rewritten, and every new
-- column carries a default that reproduces the behaviour that existed before
-- this migration ran.

-- 1. Per-employee payroll policy -------------------------------------------
-- Every policy column is NULL-able: NULL means "not configured for this
-- employee", and the calculator falls back to the company-wide setting. A
-- stored 0 is a real decision ("deduct nothing") and must stay distinguishable
-- from NULL, which is why no numeric default is given.
CREATE TABLE `employee_payroll_policies` (
    `id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `late_deduction_type` ENUM('NONE', 'PER_HOUR_FROM_BASE', 'FIXED_AMOUNT') NULL,
    `late_deduction_amount` DECIMAL(15, 2) NULL,
    `leave_deduction_type` ENUM('NONE', 'PER_DAY_FROM_BASE', 'FIXED_AMOUNT') NULL,
    `leave_deduction_amount` DECIMAL(15, 2) NULL,
    `absence_deduction_type` ENUM('NONE', 'PER_DAY_FROM_BASE', 'FIXED_AMOUNT') NULL,
    `absence_deduction_amount` DECIMAL(15, 2) NULL,
    `social_security_amount` DECIMAL(15, 2) NULL,
    `tax_amount` DECIMAL(15, 2) NULL,
    `note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NULL,
    `updated_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employee_payroll_policies_employee_id_key`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `employee_payroll_policies`
    ADD CONSTRAINT `employee_payroll_policies_employee_id_fkey`
    FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. New payroll-employee statuses ------------------------------------------
-- Appended to the existing list; NEEDS_REVIEW and MISSING_DATA are retained so
-- rows already calculated keep exactly the meaning they were written with.
ALTER TABLE `payroll_employees`
    MODIFY `status` ENUM(
        'READY',
        'PARTIAL',
        'UNCONFIGURED',
        'ATTENDANCE_INCOMPLETE',
        'NEEDS_REVIEW',
        'MISSING_DATA',
        'EXCLUDED'
    ) NOT NULL DEFAULT 'NEEDS_REVIEW';

-- 3. LEAVE becomes its own payslip line kind, separate from ABSENCE ---------
ALTER TABLE `payroll_incomes`
    MODIFY `kind` ENUM(
        'BASE_SALARY','OT','ALLOWANCE','BONUS','COMMISSION','OTHER_INCOME',
        'LATE','ABSENCE','LEAVE','SOCIAL_SECURITY','TAX','LOAN','OTHER_DEDUCTION'
    ) NOT NULL;

ALTER TABLE `payroll_deductions`
    MODIFY `kind` ENUM(
        'BASE_SALARY','OT','ALLOWANCE','BONUS','COMMISSION','OTHER_INCOME',
        'LATE','ABSENCE','LEAVE','SOCIAL_SECURITY','TAX','LOAN','OTHER_DEDUCTION'
    ) NOT NULL;

-- 4. Per-employee payroll result detail -------------------------------------
-- pay_configured defaults to 1 and is_estimate to 0 so existing calculated rows
-- keep reading as complete, finalised figures.
ALTER TABLE `payroll_employees`
    ADD COLUMN `unpaid_leave_days` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `daily_base` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `hourly_base` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `late_deduction_hours` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `leave_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `pay_configured` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `is_estimate` BOOLEAN NOT NULL DEFAULT false;
