-- ---------------------------------------------------------------------------
-- Payroll system database provisioning
--
-- Target server : 192.168.2.135:3306  (MariaDB 12.3.3)
-- Creates       : database `s2apayroll` + user `s2apayroll`
-- Never touches : `s2a_erp_main`, `s2a_erp`, or any other existing database
--
-- Run as a MariaDB administrator, e.g. in DBeaver against 192.168.2.135.
--
-- NOTE ON GRANT HOSTS
-- The payroll application does NOT run on the database server: it runs on the
-- developer machine (192.168.2.22 / 192.168.2.23) and connects across the LAN.
-- A grant to 'localhost' or '127.0.0.1' would therefore never match and login
-- would fail with "Access denied". The grants below are scoped to the
-- 192.168.2.% subnet instead — tight enough to exclude the internet, wide
-- enough to survive a DHCP lease change on the developer machine.
-- ---------------------------------------------------------------------------

-- 1. Create the dedicated payroll database (no-op if it already exists).
CREATE DATABASE IF NOT EXISTS `s2apayroll`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- 2. Create the dedicated application user.
--    Replace <SECURE_PASSWORD> with a strong password before running.
CREATE USER IF NOT EXISTS 's2apayroll'@'192.168.2.%'
  IDENTIFIED BY '<SECURE_PASSWORD>';

-- 3. Grant privileges ONLY on the payroll database.
--    This user has no access whatsoever to s2a_erp_main or s2a_erp.
GRANT ALL PRIVILEGES ON `s2apayroll`.* TO 's2apayroll'@'192.168.2.%';

FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------------
-- Verification — all read-only.
-- ---------------------------------------------------------------------------

-- The payroll database exists:
SHOW DATABASES LIKE 's2apayroll';

-- The user is scoped to the payroll database only. Expect exactly one
-- GRANT USAGE line plus one GRANT ALL ... ON `s2apayroll`.* line, and
-- nothing referencing s2a_erp_main:
SHOW GRANTS FOR 's2apayroll'@'192.168.2.%';
