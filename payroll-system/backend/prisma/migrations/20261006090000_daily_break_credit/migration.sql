-- Additive audit fields only. Existing payroll amounts and statuses, including
-- APPROVED/PAID/LOCKED rows, are not recalculated or rewritten.
ALTER TABLE `payroll_employees`
  ADD COLUMN `session_gap_minutes` INT NOT NULL DEFAULT 0 AFTER `unpaid_leave_days`,
  ADD COLUMN `required_break_minutes` INT NOT NULL DEFAULT 0 AFTER `session_gap_minutes`,
  ADD COLUMN `credited_break_minutes` INT NOT NULL DEFAULT 0 AFTER `required_break_minutes`,
  ADD COLUMN `additional_break_deduction_minutes` INT NOT NULL DEFAULT 0 AFTER `credited_break_minutes`;

-- Retire the old eight-hour DAILY threshold. The new four-hour policy is the
-- sole authority and applies only when an editable period is explicitly
-- recalculated; this migration does not rewrite any payroll result.
UPDATE `payroll_settings`
SET
  `value` = '240',
  `label` = 'เกณฑ์พักพนักงานรายวัน (นาที)',
  `description` = 'ใช้เฉพาะ DAILY: ทำงานจริงมากกว่า 240 นาทีต้องมีเวลาพักรวม 60 นาที ช่วงออกงานจริงระหว่างรอบนับเป็นเครดิตและไม่ถูกหักซ้ำ'
WHERE `key` = 'DAILY_BREAK_THRESHOLD_MINUTES';

-- Rename the old "deduction" setting to express what the value actually is:
-- the total required break before real session gaps are credited.
UPDATE `payroll_settings` AS `old_setting`
LEFT JOIN `payroll_settings` AS `new_setting`
  ON `new_setting`.`key` = 'DAILY_REQUIRED_BREAK_MINUTES'
SET
  `old_setting`.`key` = 'DAILY_REQUIRED_BREAK_MINUTES',
  `old_setting`.`value` = '60',
  `old_setting`.`label` = 'เวลาพักที่บริษัทกำหนดสำหรับพนักงานรายวัน (นาที)',
  `old_setting`.`description` = 'ระบบหักเฉพาะส่วนที่ยังขาดจากช่วงออกงานจริง ก่อนปัดเวลาลงตามช่วงเวลากลาง'
WHERE `old_setting`.`key` = 'DAILY_BREAK_DEDUCTION_MINUTES'
  AND `new_setting`.`key` IS NULL;

-- If a deployment already introduced the new key, remove only the obsolete
-- duplicate setting row. No attendance or payroll data is involved.
DELETE `old_setting`
FROM `payroll_settings` AS `old_setting`
INNER JOIN `payroll_settings` AS `new_setting`
  ON `new_setting`.`key` = 'DAILY_REQUIRED_BREAK_MINUTES'
WHERE `old_setting`.`key` = 'DAILY_BREAK_DEDUCTION_MINUTES';

UPDATE `payroll_settings`
SET
  `value` = '60',
  `label` = 'เวลาพักที่บริษัทกำหนดสำหรับพนักงานรายวัน (นาที)',
  `description` = 'ระบบหักเฉพาะส่วนที่ยังขาดจากช่วงออกงานจริง ก่อนปัดเวลาลงตามช่วงเวลากลาง'
WHERE `key` = 'DAILY_REQUIRED_BREAK_MINUTES';
