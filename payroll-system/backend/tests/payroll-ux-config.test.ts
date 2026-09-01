import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('payroll UX and effective-dated configuration', () => {
  it('calculates immediately only after an automatic successful pre-check', () => {
    const page = read('frontend/src/pages/PayrollDetailPage.tsx');
    expect(page).toContain('const report = await payrollApi.preCheck(periodId)');
    // The dialog opens whenever anyone is not ready, not only on a blocker.
    expect(page).toContain(
      'if (report.canCalculate && report.readiness.ready === report.readiness.employees)'
    );
    expect(page).toContain("actionMutation.mutate('calculate')");
    expect(page).toContain('setPreCheckOpen(true)');
  });

  it('separates system and payroll settings in navigation', () => {
    const layout = read('frontend/src/layouts/AppLayout.tsx');
    expect(layout).toContain("label: 'ตั้งค่าเงินเดือน'");
    expect(layout).toContain("label: 'ตั้งค่าระบบ'");
    expect(read('frontend/src/app/App.tsx')).toContain('path="payroll-settings"');
  });

  it('does not expose internal setting keys in the settings form', () => {
    const settings = read('frontend/src/pages/SettingsPage.tsx');
    expect(settings).not.toContain('font-mono text-muted-foreground">{setting.key}');
  });

  it('models effective-dated pay, work schedules, and typed holidays', () => {
    const schema = read('backend/prisma/schema.prisma');
    expect(schema).toContain('model EmployeePayProfile');
    expect(schema).toContain('model WorkScheduleProfile');
    expect(schema).toContain('enum HolidayType');
    expect(schema).toContain('effectiveFrom');
  });
});
