-- Distinguish "a human edited the punches" from "a human chose the status".
-- is_corrected covered both, so recalculateRange froze the status of every
-- corrected day - leaving a day whose missing punch had just been supplied
-- stuck on its pre-correction MISSING_DATA status.
ALTER TABLE `attendance_records`
  ADD COLUMN `status_override` BOOLEAN NOT NULL DEFAULT false;

-- Stable identity for a row imported from the LeaveRequests sheet, so a
-- repeated read-only sync updates the existing leave instead of appending a
-- duplicate. Nullable: leave entered by hand in the app has no sheet origin.
ALTER TABLE `leave_records`
  ADD COLUMN `source_request_id` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `leave_records_source_request_id_key`
  ON `leave_records`(`source_request_id`);
