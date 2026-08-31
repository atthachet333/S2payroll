ALTER TABLE `employees`
  ADD COLUMN `attendance_required` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `leave_tracking_required` BOOLEAN NOT NULL DEFAULT true;

