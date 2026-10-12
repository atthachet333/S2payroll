-- Additive only: one-day expected schedule exceptions. No attendance, payroll,
-- salary, or Google Sheets rows are rewritten by this migration.
CREATE TABLE `employee_work_schedule_overrides` (
  `id` CHAR(36) NOT NULL,
  `employee_id` CHAR(36) NOT NULL,
  `work_date` DATE NOT NULL,
  `work_start_time` VARCHAR(5) NOT NULL,
  `work_end_time` VARCHAR(5) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `employee_work_schedule_override_date_key` (`employee_id`, `work_date`),
  INDEX `employee_work_schedule_override_work_date_idx` (`work_date`),
  INDEX `employee_work_schedule_override_created_by_idx` (`created_by`),
  PRIMARY KEY (`id`),
  CONSTRAINT `employee_work_schedule_override_employee_fkey`
    FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `employee_work_schedule_override_created_by_fkey`
    FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
