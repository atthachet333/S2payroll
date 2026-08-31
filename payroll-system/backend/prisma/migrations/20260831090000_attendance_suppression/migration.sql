-- A workday a human deliberately removed from the payroll system.
-- The Google Sheet is read-only and remains the source of truth, so without
-- this record the next sync would simply re-import the deleted day.
CREATE TABLE `attendance_suppressions` (
  `id` CHAR(36) NOT NULL,
  `employee_id` CHAR(36) NOT NULL,
  `employee_code` VARCHAR(32) NOT NULL,
  `work_date` DATE NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `previous_check_in` DATETIME(3) NULL,
  `previous_check_out` DATETIME(3) NULL,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `attendance_suppressions_employee_id_work_date_key` (`employee_id`, `work_date`),
  INDEX `attendance_suppressions_work_date_idx` (`work_date`),
  CONSTRAINT `attendance_suppressions_employee_id_fkey`
    FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
