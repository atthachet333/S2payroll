-- Effective-dated employee compensation. Existing employees are deliberately
-- not backfilled: real salary/rate data must be entered by an authorized user.
CREATE TABLE `employee_pay_profiles` (
  `id` CHAR(36) NOT NULL,
  `employee_id` CHAR(36) NOT NULL,
  `pay_type` ENUM('MONTHLY', 'HOURLY') NOT NULL,
  `monthly_salary` DECIMAL(15,2) NULL,
  `hourly_rate` DECIMAL(15,2) NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_by` CHAR(36) NULL,
  `updated_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `employee_pay_effective_from` (`employee_id`, `effective_from`),
  INDEX `employee_pay_profiles_employee_id_is_active_effective_from_idx` (`employee_id`, `is_active`, `effective_from`),
  PRIMARY KEY (`id`),
  CONSTRAINT `employee_pay_profiles_employee_id_fkey`
    FOREIGN KEY (`employee_id`) REFERENCES `employees` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Date-effective company work schedules. No historical profile is fabricated;
-- the current PayrollSetting values remain the fallback until one is entered.
CREATE TABLE `work_schedule_profiles` (
  `id` CHAR(36) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `effective_from` DATE NOT NULL,
  `effective_to` DATE NULL,
  `working_days` VARCHAR(64) NOT NULL,
  `work_start_time` VARCHAR(5) NOT NULL,
  `work_end_time` VARCHAR(5) NOT NULL,
  `flex_arrival_minutes` INTEGER NOT NULL DEFAULT 0,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_by` CHAR(36) NULL,
  `updated_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `work_schedule_profiles_effective_from_key` (`effective_from`),
  INDEX `work_schedule_profiles_is_active_effective_from_effective_to_idx` (`is_active`, `effective_from`, `effective_to`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `holidays`
  ADD COLUMN `type` ENUM('PUBLIC_HOLIDAY', 'COMPANY_HOLIDAY') NOT NULL DEFAULT 'COMPANY_HOLIDAY',
  ADD COLUMN `note` VARCHAR(500) NULL;
