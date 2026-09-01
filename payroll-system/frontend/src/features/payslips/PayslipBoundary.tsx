import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Catches a render failure inside the payslip sheet.
 *
 * This exists because of a real outage: the sheet read a field that older
 * frozen snapshots do not carry, threw mid-render, and React unmounted the
 * subtree - so "ดูสลิปเงินเดือน" opened a blank dialog with the reason visible
 * only in the browser console. A payslip that cannot be drawn must say so on
 * screen, in Thai, without putting a stack trace in front of a payroll clerk.
 */
export default class PayslipBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // The detail belongs in the console for an engineer, never on the page.
    console.error('Payslip render failed', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto max-w-[794px] rounded-lg border border-danger/30 bg-danger-soft/60 px-5 py-6 text-sm text-danger-fg">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-semibold">ไม่สามารถแสดงสลิปเงินเดือนได้</p>
            <p className="mt-1">
              ข้อมูลสลิปของรายการนี้ไม่ครบถ้วนหรืออยู่ในรูปแบบเดิม
              กรุณาคำนวณเงินเดือนรอบนี้ใหม่ แล้วเปิดสลิปอีกครั้ง
            </p>
          </div>
        </div>
      </div>
    );
  }
}
