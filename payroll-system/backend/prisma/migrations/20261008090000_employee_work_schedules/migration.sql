-- Additive only: personal work-time ranges. Attendance punches and historical
-- payroll rows are not rewritten by this migration.
CREATE TABLE `employee_work_schedules` (
  `id` CHAR(36) NOT NULL,
  `employee_id` CHAR(36) NOT NULL,
  `work_start_time` VARCHAR(5) NOT NULL,
  `work_end_time` VARCHAR(5) NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_by` CHAR(36) NULL,
  `updated_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `employee_work_schedule_effective_from_key` (`employee_id`, `effective_from`),
  INDEX `employee_work_schedule_effective_range_idx`
    (`employee_id`, `is_active`, `effective_from`, `effective_to`),
  PRIMARY KEY (`id`),
  CONSTRAINT `employee_work_schedules_employee_id_fkey`
    FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
