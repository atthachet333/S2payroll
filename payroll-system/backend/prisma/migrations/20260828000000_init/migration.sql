-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `code` ENUM('SUPER_ADMIN', 'ADMIN', 'HR', 'PAYROLL', 'VIEWER') NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `description` VARCHAR(255) NULL,
    `permissions` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roles_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `last_name` VARCHAR(100) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `last_login_at` DATETIME(3) NULL,
    `employee_id` CHAR(36) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    UNIQUE INDEX `users_employee_id_key`(`employee_id`),
    INDEX `users_role_id_idx`(`role_id`),
    INDEX `users_is_active_idx`(`is_active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_tokens` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(255) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `user_agent` VARCHAR(255) NULL,
    `ip_address` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refresh_tokens_token_hash_key`(`token_hash`),
    INDEX `refresh_tokens_user_id_idx`(`user_id`),
    INDEX `refresh_tokens_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `companies` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `tax_id` VARCHAR(32) NULL,
    `address` VARCHAR(500) NULL,
    `phone` VARCHAR(32) NULL,
    `email` VARCHAR(191) NULL,
    `logo_url` VARCHAR(500) NULL,
    `sso_branch_no` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `departments_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `positions` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `department_id` CHAR(36) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `positions_code_key`(`code`),
    INDEX `positions_department_id_idx`(`department_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` CHAR(36) NOT NULL,
    `employee_code` VARCHAR(32) NOT NULL,
    `first_name` VARCHAR(100) NOT NULL,
    `last_name` VARCHAR(100) NOT NULL,
    `nickname` VARCHAR(64) NULL,
    `national_id` VARCHAR(32) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(32) NULL,
    `department_id` CHAR(36) NULL,
    `position_id` CHAR(36) NULL,
    `employment_type` ENUM('MONTHLY', 'DAILY', 'HOURLY', 'CONTRACT') NOT NULL DEFAULT 'MONTHLY',
    `start_date` DATE NOT NULL,
    `end_date` DATE NULL,
    `base_salary` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `bank_name` VARCHAR(100) NULL,
    `bank_account` VARCHAR(64) NULL,
    `tax_id` VARCHAR(32) NULL,
    `social_security` VARCHAR(32) NULL,
    `sso_enabled` BOOLEAN NOT NULL DEFAULT true,
    `tax_enabled` BOOLEAN NOT NULL DEFAULT true,
    `ot_eligible` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('ACTIVE', 'INACTIVE', 'TERMINATED', 'PROBATION') NOT NULL DEFAULT 'ACTIVE',
    `note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_employee_code_key`(`employee_code`),
    INDEX `employees_department_id_idx`(`department_id`),
    INDEX `employees_position_id_idx`(`position_id`),
    INDEX `employees_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_history` (
    `id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `previous_salary` DECIMAL(15, 2) NOT NULL,
    `new_salary` DECIMAL(15, 2) NOT NULL,
    `effective_date` DATE NOT NULL,
    `reason` VARCHAR(255) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `salary_history_employee_id_effective_date_idx`(`employee_id`, `effective_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_raw_data` (
    `id` CHAR(36) NOT NULL,
    `sync_id` CHAR(36) NULL,
    `employee_code` VARCHAR(32) NOT NULL,
    `raw_date` VARCHAR(64) NOT NULL,
    `raw_check_in` VARCHAR(64) NULL,
    `raw_check_out` VARCHAR(64) NULL,
    `row_hash` VARCHAR(64) NOT NULL,
    `sheet_row` INTEGER NULL,
    `payload` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_raw_data_employee_code_raw_date_idx`(`employee_code`, `raw_date`),
    INDEX `attendance_raw_data_row_hash_idx`(`row_hash`),
    INDEX `attendance_raw_data_sync_id_idx`(`sync_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_records` (
    `id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `employee_code` VARCHAR(32) NOT NULL,
    `work_date` DATE NOT NULL,
    `check_in` DATETIME(3) NULL,
    `check_out` DATETIME(3) NULL,
    `original_check_in` DATETIME(3) NULL,
    `original_check_out` DATETIME(3) NULL,
    `worked_minutes` INTEGER NOT NULL DEFAULT 0,
    `normal_minutes` INTEGER NOT NULL DEFAULT 0,
    `ot_minutes` INTEGER NOT NULL DEFAULT 0,
    `break_minutes` INTEGER NOT NULL DEFAULT 0,
    `late_minutes` INTEGER NOT NULL DEFAULT 0,
    `early_leave_minutes` INTEGER NOT NULL DEFAULT 0,
    `is_missing_check_in` BOOLEAN NOT NULL DEFAULT false,
    `is_missing_check_out` BOOLEAN NOT NULL DEFAULT false,
    `is_absent` BOOLEAN NOT NULL DEFAULT false,
    `is_holiday` BOOLEAN NOT NULL DEFAULT false,
    `is_weekend` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('NORMAL', 'LATE', 'OT', 'ABSENT', 'MISSING_DATA', 'LEAVE', 'HOLIDAY') NOT NULL DEFAULT 'NORMAL',
    `source` ENUM('GOOGLE_SHEET', 'MANUAL', 'IMPORT_FILE') NOT NULL DEFAULT 'GOOGLE_SHEET',
    `is_corrected` BOOLEAN NOT NULL DEFAULT false,
    `is_locked` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(500) NULL,
    `raw_data_id` CHAR(36) NULL,
    `last_sync_id` CHAR(36) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_records_work_date_idx`(`work_date`),
    INDEX `attendance_records_status_idx`(`status`),
    INDEX `attendance_records_employee_code_work_date_idx`(`employee_code`, `work_date`),
    INDEX `attendance_records_raw_data_id_idx`(`raw_data_id`),
    UNIQUE INDEX `attendance_records_employee_id_work_date_key`(`employee_id`, `work_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance_adjustments` (
    `id` CHAR(36) NOT NULL,
    `attendance_record_id` CHAR(36) NOT NULL,
    `field_name` VARCHAR(64) NOT NULL,
    `old_value` VARCHAR(255) NULL,
    `new_value` VARCHAR(255) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `changed_by` CHAR(36) NOT NULL,
    `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `attendance_adjustments_attendance_record_id_idx`(`attendance_record_id`),
    INDEX `attendance_adjustments_changed_by_idx`(`changed_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_records` (
    `id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `leave_type` ENUM('ANNUAL', 'SICK', 'PERSONAL', 'MATERNITY', 'UNPAID', 'OTHER') NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `total_days` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    `is_paid` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'APPROVED',
    `reason` VARCHAR(500) NULL,
    `approved_by` CHAR(36) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_records_employee_id_start_date_end_date_idx`(`employee_id`, `start_date`, `end_date`),
    INDEX `leave_records_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `id` CHAR(36) NOT NULL,
    `date` DATE NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `is_paid` BOOLEAN NOT NULL DEFAULT true,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `holidays_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_periods` (
    `id` CHAR(36) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `payment_date` DATE NULL,
    `status` ENUM('DRAFT', 'ATTENDANCE_REVIEW', 'CALCULATED', 'REVIEW', 'APPROVED', 'PAID', 'LOCKED') NOT NULL DEFAULT 'DRAFT',
    `total_employees` INTEGER NOT NULL DEFAULT 0,
    `gross_total` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `ot_total` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `deduction_total` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `net_total` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `calculated_at` DATETIME(3) NULL,
    `approved_at` DATETIME(3) NULL,
    `approved_by` CHAR(36) NULL,
    `paid_at` DATETIME(3) NULL,
    `paid_by` CHAR(36) NULL,
    `locked_at` DATETIME(3) NULL,
    `locked_by` CHAR(36) NULL,
    `settings_snapshot` JSON NULL,
    `note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_periods_code_key`(`code`),
    INDEX `payroll_periods_status_idx`(`status`),
    UNIQUE INDEX `payroll_periods_year_month_key`(`year`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_employees` (
    `id` CHAR(36) NOT NULL,
    `period_id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `employee_code` VARCHAR(32) NOT NULL,
    `employee_name` VARCHAR(201) NOT NULL,
    `department_name` VARCHAR(191) NULL,
    `position_name` VARCHAR(191) NULL,
    `employment_type` ENUM('MONTHLY', 'DAILY', 'HOURLY', 'CONTRACT') NOT NULL,
    `working_days` INTEGER NOT NULL DEFAULT 0,
    `present_days` INTEGER NOT NULL DEFAULT 0,
    `absent_days` INTEGER NOT NULL DEFAULT 0,
    `leave_days` DECIMAL(6, 2) NOT NULL DEFAULT 0,
    `late_count` INTEGER NOT NULL DEFAULT 0,
    `late_minutes` INTEGER NOT NULL DEFAULT 0,
    `working_hours` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `ot_hours` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `ot_weekday_hours` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `ot_weekend_hours` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `ot_holiday_hours` DECIMAL(8, 2) NOT NULL DEFAULT 0,
    `missing_data_days` INTEGER NOT NULL DEFAULT 0,
    `base_salary` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `ot_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `allowance_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `bonus_amount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `other_income` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `gross_income` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `late_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `absence_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `social_security` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `tax` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `loan_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `other_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `total_deduction` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `net_salary` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `status` ENUM('READY', 'NEEDS_REVIEW', 'MISSING_DATA', 'EXCLUDED') NOT NULL DEFAULT 'NEEDS_REVIEW',
    `review_notes` JSON NULL,
    `has_adjustment` BOOLEAN NOT NULL DEFAULT false,
    `calculated_at` DATETIME(3) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_employees_period_id_status_idx`(`period_id`, `status`),
    INDEX `payroll_employees_employee_id_idx`(`employee_id`),
    UNIQUE INDEX `payroll_employees_period_id_employee_id_key`(`period_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_incomes` (
    `id` CHAR(36) NOT NULL,
    `payroll_employee_id` CHAR(36) NOT NULL,
    `kind` ENUM('BASE_SALARY', 'OT', 'ALLOWANCE', 'BONUS', 'OTHER_INCOME', 'LATE', 'ABSENCE', 'SOCIAL_SECURITY', 'TAX', 'LOAN', 'OTHER_DEDUCTION') NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(10, 2) NULL,
    `rate` DECIMAL(15, 4) NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `is_manual` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_incomes_payroll_employee_id_idx`(`payroll_employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_deductions` (
    `id` CHAR(36) NOT NULL,
    `payroll_employee_id` CHAR(36) NOT NULL,
    `kind` ENUM('BASE_SALARY', 'OT', 'ALLOWANCE', 'BONUS', 'OTHER_INCOME', 'LATE', 'ABSENCE', 'SOCIAL_SECURITY', 'TAX', 'LOAN', 'OTHER_DEDUCTION') NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(10, 2) NULL,
    `rate` DECIMAL(15, 4) NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `is_manual` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(500) NULL,
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_deductions_payroll_employee_id_idx`(`payroll_employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_adjustments` (
    `id` CHAR(36) NOT NULL,
    `payroll_employee_id` CHAR(36) NOT NULL,
    `field_name` VARCHAR(64) NOT NULL,
    `old_value` VARCHAR(255) NULL,
    `new_value` VARCHAR(255) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `changed_by` CHAR(36) NOT NULL,
    `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_adjustments_payroll_employee_id_idx`(`payroll_employee_id`),
    INDEX `payroll_adjustments_changed_by_idx`(`changed_by`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payslips` (
    `id` CHAR(36) NOT NULL,
    `payslip_no` VARCHAR(64) NOT NULL,
    `period_id` CHAR(36) NOT NULL,
    `employee_id` CHAR(36) NOT NULL,
    `payroll_employee_id` CHAR(36) NOT NULL,
    `payment_date` DATE NULL,
    `snapshot` JSON NOT NULL,
    `net_salary` DECIMAL(15, 2) NOT NULL,
    `issued_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payslips_payslip_no_key`(`payslip_no`),
    UNIQUE INDEX `payslips_payroll_employee_id_key`(`payroll_employee_id`),
    INDEX `payslips_period_id_idx`(`period_id`),
    INDEX `payslips_employee_id_idx`(`employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_settings` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `value_type` ENUM('STRING', 'NUMBER', 'DECIMAL', 'BOOLEAN', 'TIME', 'JSON') NOT NULL DEFAULT 'STRING',
    `group` VARCHAR(64) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `description` VARCHAR(500) NULL,
    `updated_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_settings_key_key`(`key`),
    INDEX `payroll_settings_group_idx`(`group`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `google_sheet_syncs` (
    `id` CHAR(36) NOT NULL,
    `sheet_id` VARCHAR(191) NOT NULL,
    `sheet_range` VARCHAR(191) NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `total_rows` INTEGER NOT NULL DEFAULT 0,
    `imported_count` INTEGER NOT NULL DEFAULT 0,
    `updated_count` INTEGER NOT NULL DEFAULT 0,
    `skipped_count` INTEGER NOT NULL DEFAULT 0,
    `duplicate_count` INTEGER NOT NULL DEFAULT 0,
    `protected_count` INTEGER NOT NULL DEFAULT 0,
    `error_count` INTEGER NOT NULL DEFAULT 0,
    `errors` JSON NULL,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `duration_ms` INTEGER NULL,
    `triggered_by` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `google_sheet_syncs_status_idx`(`status`),
    INDEX `google_sheet_syncs_started_at_idx`(`started_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `user_email` VARCHAR(191) NULL,
    `action` VARCHAR(64) NOT NULL,
    `entity` VARCHAR(64) NOT NULL,
    `entity_id` VARCHAR(64) NULL,
    `old_value` JSON NULL,
    `new_value` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `ip_address` VARCHAR(64) NULL,
    `user_agent` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `audit_logs_entity_entity_id_idx`(`entity`, `entity_id`),
    INDEX `audit_logs_user_id_idx`(`user_id`),
    INDEX `audit_logs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refresh_tokens` ADD CONSTRAINT `refresh_tokens_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `positions` ADD CONSTRAINT `positions_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_position_id_fkey` FOREIGN KEY (`position_id`) REFERENCES `positions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `salary_history` ADD CONSTRAINT `salary_history_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_raw_data` ADD CONSTRAINT `attendance_raw_data_sync_id_fkey` FOREIGN KEY (`sync_id`) REFERENCES `google_sheet_syncs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_raw_data_id_fkey` FOREIGN KEY (`raw_data_id`) REFERENCES `attendance_raw_data`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_adjustments` ADD CONSTRAINT `attendance_adjustments_attendance_record_id_fkey` FOREIGN KEY (`attendance_record_id`) REFERENCES `attendance_records`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_records` ADD CONSTRAINT `leave_records_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_employees` ADD CONSTRAINT `payroll_employees_period_id_fkey` FOREIGN KEY (`period_id`) REFERENCES `payroll_periods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_employees` ADD CONSTRAINT `payroll_employees_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_incomes` ADD CONSTRAINT `payroll_incomes_payroll_employee_id_fkey` FOREIGN KEY (`payroll_employee_id`) REFERENCES `payroll_employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_deductions` ADD CONSTRAINT `payroll_deductions_payroll_employee_id_fkey` FOREIGN KEY (`payroll_employee_id`) REFERENCES `payroll_employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_adjustments` ADD CONSTRAINT `payroll_adjustments_payroll_employee_id_fkey` FOREIGN KEY (`payroll_employee_id`) REFERENCES `payroll_employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_period_id_fkey` FOREIGN KEY (`period_id`) REFERENCES `payroll_periods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_employee_id_fkey` FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payslips` ADD CONSTRAINT `payslips_payroll_employee_id_fkey` FOREIGN KEY (`payroll_employee_id`) REFERENCES `payroll_employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

