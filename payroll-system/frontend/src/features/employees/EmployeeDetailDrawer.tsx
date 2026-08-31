import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  Building2,
  ChevronDown,
  Clock,
  CreditCard,
  FileText,
  Landmark,
  Mail,
  Pencil,
  Phone,
  Settings2,
  Shield,
  ShieldCheck,
  Sparkles,
  UserRound,
  CalendarDays,
  AlertTriangle,
  IdCard,
  X,
} from 'lucide-react';
import { employeeApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  ErrorState,
  TableSkeleton,
} from '@/components/ui';
import { EMPLOYMENT_TYPE_LABELS } from '@/components/StatusBadge';
import { formatDate, formatDateTime, formatMoney } from '@/utils/format';
import type { Employee } from '@/types';

/**
 * Read-only employee profile.
 *
 * Strictly read-only: no input, switch, form, submit or mutation appears
 * anywhere in this file. The only escape hatch is "แก้ไขข้อมูล", which closes
 * this view before handing to the existing edit dialog.
 *
 * Composition is a navy hero over a slate canvas holding white cards, so the
 * panel reads as a profile rather than a form. Each card carries a restrained
 * accent so sections are distinguishable without turning the modal into a
 * dashboard; colour beyond that is reserved for status.
 *
 * This pass is visual only - completeness, exemption and compensation rules are
 * all decided by the backend and simply rendered here.
 */

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'ทำงานอยู่',
  PROBATION: 'ทดลองงาน',
  INACTIVE: 'ไม่ทำงานแล้ว',
  TERMINATED: 'พ้นสภาพ',
};

/** Initials for the avatar, taken from the Thai given and family names. */
function initialsOf(first?: string, last?: string): string {
  const a = (first ?? '').trim().charAt(0);
  const b = (last ?? '').trim().charAt(0);
  return `${a}${b}` || '?';
}

/** Translucent badge for the navy hero. */
function HeroBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'danger' | 'accent' }) {
  const toneClass = {
    neutral: 'bg-white/15 text-white ring-white/25',
    success: 'bg-emerald-400/20 text-emerald-50 ring-emerald-300/40',
    danger: 'bg-rose-400/20 text-rose-50 ring-rose-300/40',
    accent: 'bg-sky-400/20 text-sky-50 ring-sky-300/40',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${toneClass}`}>
      {children}
    </span>
  );
}

/** Label above value. No box - grouping comes from the card and the grid. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

const ACCENTS = {
  blue: 'bg-primary/10 text-primary',
  emerald: 'bg-emerald-50 text-emerald-700',
  indigo: 'bg-indigo-50 text-indigo-700',
  slate: 'bg-slate-100 text-slate-600',
} as const;

function Card({
  title,
  icon,
  accent,
  emphasis = false,
  note,
  children,
}: {
  title: string;
  icon: ReactNode;
  accent: keyof typeof ACCENTS;
  /** Compensation carries more weight than the rest. */
  emphasis?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`rounded-xl border bg-card p-5 ${
        emphasis ? 'border-emerald-200 shadow-sm ring-1 ring-emerald-100' : 'border-border shadow-[0_1px_2px_rgba(16,24,40,0.04)]'
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${ACCENTS[accent]}`}>
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight text-foreground">{title}</h3>
          {note && <p className="text-xs leading-tight text-muted-foreground">{note}</p>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** icon + label on the left, status pill on the right. */
function PolicyRow({ icon, label, on, onText, offText }: {
  icon: ReactNode;
  label: string;
  on: boolean;
  onText: string;
  offText: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
          on ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {on ? onText : offText}
      </span>
    </div>
  );
}

function ContactRow({ icon, value }: { icon: ReactNode; value: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 text-sm text-foreground">
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

export default function EmployeeDetailDrawer({
  employee,
  onClose,
  onEdit,
}: {
  employee: Employee | null;
  onClose: () => void;
  onEdit?: (employee: Employee) => void;
}) {
  const [systemOpen, setSystemOpen] = useState(false);

  const query = useQuery({
    queryKey: ['employee', employee?.id],
    queryFn: () => employeeApi.get(employee!.id),
    enabled: Boolean(employee),
    initialData: employee ?? undefined,
  });
  const payProfilesQuery = useQuery({
    queryKey: ['employee-pay-profiles', employee?.id],
    queryFn: () => employeeApi.payProfiles(employee!.id),
    enabled: Boolean(employee),
  });

  const detail = query.data;
  const completeness = detail?.profileCompleteness;
  const exempt = completeness?.exempt ?? false;

  const payType = detail?.employmentType;
  const compensationLabel =
    payType === 'DAILY' || payType === 'HOURLY'
        ? 'อัตราค่าจ้างรายชั่วโมง'
        : 'เงินเดือนพื้นฐาน';
  const compensationUnit = payType === 'DAILY' || payType === 'HOURLY' ? ' / ชั่วโมง' : '';

  // Only render contact rows that carry a value, so the card never becomes a
  // column of dashes. Values are shown as stored - this pass introduces no
  // masking, because the product has no existing pattern for it.
  const contacts = detail
    ? ([
        [<Mail key="m" className="h-4 w-4" />, detail.email],
        [<Phone key="p" className="h-4 w-4" />, detail.phone],
        [<Landmark key="b" className="h-4 w-4" />, detail.bankName],
        [<CreditCard key="a" className="h-4 w-4" />, detail.bankAccount],
        [<FileText key="t" className="h-4 w-4" />, detail.taxId],
        [<ShieldCheck key="s" className="h-4 w-4" />, detail.socialSecurity],
      ] as const).filter(([, value]) => Boolean(value && String(value).trim()))
    : [];

  return (
    <Dialog open={Boolean(employee)} onOpenChange={(open) => !open && onClose()}>
      {/* The title bar is rendered below rather than through the `title` prop:
          with p-0 on the content the built-in block sits flush against the
          corner. hideDefaultClose moves the close control into that bar. */}
      <DialogContent
        hideDefaultClose
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden p-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200/70 bg-card px-4 py-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-2.5">
            <IdCard className="h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <DialogTitle className="truncate text-lg font-semibold leading-tight text-foreground">
                ข้อมูลพนักงาน
              </DialogTitle>
              <DialogDescription className="truncate text-xs text-muted-foreground">
                รายละเอียดข้อมูลและสถานะพนักงาน
              </DialogDescription>
            </div>
          </div>
          <DialogClose className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <X className="h-4 w-4" />
            <span className="sr-only">ปิด</span>
          </DialogClose>
        </div>

        {query.isError ? (
          <div className="p-6">
            <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} />
          </div>
        ) : !detail ? (
          <div className="p-6">
            <TableSkeleton rows={5} cols={1} />
          </div>
        ) : (
          <>
            {/* ---- Navy hero. Never scrolls away. ---- */}
            <header className="shrink-0 bg-gradient-to-br from-[hsl(224_64%_24%)] via-[hsl(224_64%_31%)] to-[hsl(212_70%_38%)] px-7 py-6 text-white">
              <div className="flex flex-wrap items-start gap-4">
                <span className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-white/15 text-xl font-semibold text-white ring-1 ring-white/25">
                  {initialsOf(detail.firstName, detail.lastName)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="flex items-center gap-2 text-2xl font-semibold leading-tight">
                    <span className="truncate">
                      {detail.firstName} {detail.lastName}
                    </span>
                    {exempt && <Sparkles className="h-4 w-4 shrink-0 text-sky-200" aria-hidden />}
                  </h2>
                  <p className="mt-1 truncate text-sm text-white/80">
                    {detail.employeeCode} · {detail.position?.name ?? '-'}
                  </p>
                  <p className="truncate text-sm text-white/65">{detail.department?.name ?? '-'}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <HeroBadge tone={detail.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {STATUS_LABELS[detail.status] ?? detail.status}
                    </HeroBadge>
                    <HeroBadge>
                      {EMPLOYMENT_TYPE_LABELS[detail.employmentType] ?? detail.employmentType}
                    </HeroBadge>
                    {exempt && <HeroBadge tone="accent">ผู้บริหาร</HeroBadge>}
                    {completeness && (
                      <HeroBadge tone={completeness.complete ? 'success' : 'danger'}>
                        {completeness.complete
                          ? 'ข้อมูลครบ'
                          : `ข้อมูลไม่ครบ ${completeness.missingCount} รายการ`}
                      </HeroBadge>
                    )}
                  </div>
                </div>
              </div>
            </header>

            {/* ---- Slate canvas. Only this scrolls. ---- */}
            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 px-7 py-6">
              {/* Glanceable strip */}
              <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
                {[
                  ['รหัสพนักงาน', detail.employeeCode],
                  ['วันที่เริ่มงาน', formatDate(detail.startDate)],
                  ['ประเภทพนักงาน', EMPLOYMENT_TYPE_LABELS[detail.employmentType] ?? detail.employmentType],
                  ['สถานะ', STATUS_LABELS[detail.status] ?? detail.status],
                ].map(([label, value]) => (
                  <div key={label} className="bg-card px-4 py-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>

              {/* Compact warning, only when something is genuinely missing. */}
              {completeness && !completeness.complete && (
                <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-rose-800">
                      ข้อมูลยังไม่ครบ {completeness.missingCount} รายการ
                    </p>
                    <p className="mt-0.5 text-sm text-rose-700">
                      {completeness.missingLabels.join(' · ')}
                    </p>
                  </div>
                </div>
              )}

              {/* General information gets the wider column. */}
              <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
                <div className="space-y-5">
                  <Card title="ข้อมูลทั่วไป" icon={<UserRound className="h-4 w-4" />} accent="blue">
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                      <Field label="แผนก" value={detail.department?.name ?? '-'} />
                      <Field label="ตำแหน่ง" value={detail.position?.name ?? '-'} />
                      <Field label="วันที่เริ่มงาน" value={formatDate(detail.startDate)} />
                      <Field
                        label="สถานะ"
                        value={
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                detail.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-slate-400'
                              }`}
                              aria-hidden
                            />
                            {STATUS_LABELS[detail.status] ?? detail.status}
                          </span>
                        }
                      />
                      {detail.endDate && (
                        <Field label="วันที่สิ้นสุด" value={formatDate(detail.endDate)} />
                      )}
                    </dl>
                  </Card>

                  <Card
                    title="ข้อมูลการทำงาน"
                    icon={<Settings2 className="h-4 w-4" />}
                    accent="indigo"
                    note={exempt ? 'ผู้บริหารได้รับการยกเว้นการลงเวลาและการลาตามนโยบาย' : undefined}
                  >
                    <div className="divide-y divide-border/60">
                      <PolicyRow
                        icon={<Clock className="h-4 w-4" />}
                        label="การลงเวลา"
                        on={detail.attendanceRequired}
                        onText="ต้องบันทึก"
                        offText="ยกเว้น"
                      />
                      <PolicyRow
                        icon={<CalendarDays className="h-4 w-4" />}
                        label="การลา"
                        on={detail.leaveTrackingRequired}
                        onText="ติดตาม"
                        offText="ยกเว้น"
                      />
                      <PolicyRow
                        icon={<Clock className="h-4 w-4" />}
                        label="OT"
                        on={detail.otEligible}
                        onText="ใช้ได้"
                        offText="ไม่มีสิทธิ์"
                      />
                      <PolicyRow
                        icon={<Shield className="h-4 w-4" />}
                        label="ประกันสังคม"
                        on={detail.ssoEnabled}
                        onText="ใช้"
                        offText="ไม่หัก"
                      />
                      <PolicyRow
                        icon={<FileText className="h-4 w-4" />}
                        label="ภาษี"
                        on={detail.taxEnabled}
                        onText="ใช้"
                        offText="ไม่หัก"
                      />
                    </div>
                  </Card>
                </div>

                <div className="space-y-5">
                  {/* Compensation carries the most weight on a payroll profile. */}
                  <Card
                    title="ข้อมูลค่าตอบแทน"
                    icon={<Banknote className="h-4 w-4" />}
                    accent="emerald"
                    emphasis
                  >
                    {payProfilesQuery.data && payProfilesQuery.data.length > 0 ? (
                      <div className="space-y-3">
                        {payProfilesQuery.data.map((profile, index) => (
                          <div key={profile.id} className={index ? 'border-t border-border/60 pt-3' : ''}>
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                              {profile.payType === 'MONTHLY' ? 'รายเดือน' : 'คิดตามชั่วโมง'} · เริ่มใช้ {formatDate(profile.effectiveFrom)}
                            </p>
                            <p className="mt-1 text-xl font-semibold tracking-tight text-foreground">
                              {formatMoney(profile.payType === 'MONTHLY' ? profile.monthlySalary ?? '0' : profile.hourlyRate ?? '0')}
                              <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                                บาท{profile.payType === 'MONTHLY' ? ' / เดือน' : ' / ชั่วโมง'}
                              </span>
                            </p>
                            {profile.effectiveTo && <p className="mt-0.5 text-xs text-muted-foreground">ถึง {formatDate(profile.effectiveTo)}</p>}
                          </div>
                        ))}
                      </div>
                    ) : Number(detail.baseSalary) > 0 ? (
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {compensationLabel}
                        </p>
                        <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                          {formatMoney(detail.baseSalary)}
                          <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                            บาท{compensationUnit}
                          </span>
                        </p>
                      </div>
                    ) : exempt ? (
                      // Not required of this employee, so this is information,
                      // not an error - blue/grey, never red.
                      <div className="rounded-lg bg-slate-50 px-3.5 py-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          ค่าตอบแทน
                        </p>
                        <p className="mt-0.5 text-sm font-medium text-slate-600">
                          ไม่บังคับสำหรับผู้บริหาร
                        </p>
                      </div>
                    ) : !completeness?.compensationRequired ? (
                      // A daily/hourly rate is payroll configuration, not master
                      // data, so an unset amount is a pending step rather than a
                      // defect. Payroll's own pre-check still blocks on it.
                      <div className="rounded-lg bg-slate-50 px-3.5 py-3">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {compensationLabel}
                        </p>
                        <p className="mt-0.5 text-sm font-medium text-slate-600">
                          ยังไม่ได้กำหนด
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          ข้อมูลค่าจ้างจะกำหนดในขั้นตอน Payroll
                          ไม่มีผลกับความครบถ้วนของข้อมูลพนักงาน
                        </p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {compensationLabel}
                        </p>
                        <p className="mt-1 text-sm font-medium text-rose-600">ยังไม่ได้กำหนด</p>
                      </div>
                    )}
                  </Card>

                  <Card
                    title="ข้อมูลเพิ่มเติม"
                    icon={<Building2 className="h-4 w-4" />}
                    accent="slate"
                    note="ไม่บังคับ ไม่มีผลกับความครบถ้วนของข้อมูล"
                  >
                    {contacts.length === 0 && !detail.note ? (
                      <p className="text-sm text-muted-foreground">ยังไม่มีข้อมูลเพิ่มเติม</p>
                    ) : (
                      <div className="divide-y divide-border/60">
                        {contacts.map(([icon, value]) => (
                          <ContactRow key={String(value)} icon={icon} value={String(value)} />
                        ))}
                        {detail.note && (
                          <p className="pt-2 text-sm text-muted-foreground">{detail.note}</p>
                        )}
                      </div>
                    )}
                  </Card>
                </div>
              </div>

              {/* Quiet, collapsed by default. */}
              {(detail.createdAt || detail.updatedAt || detail.lineUserId) && (
                <div className="mt-5 overflow-hidden rounded-xl border border-border bg-slate-100/60">
                  <button
                    type="button"
                    onClick={() => setSystemOpen((open) => !open)}
                    aria-expanded={systemOpen}
                    className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-100"
                  >
                    <span>
                      <span className="block text-sm font-medium text-foreground">ข้อมูลระบบ</span>
                      <span className="block text-xs text-muted-foreground">
                        รายละเอียดทางเทคนิคและแหล่งข้อมูล
                      </span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                        systemOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {systemOpen && (
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border bg-card px-4 py-4 sm:grid-cols-3">
                      {detail.lineUserId && <Field label="LINE User ID" value={detail.lineUserId} />}
                      {detail.createdAt && (
                        <Field label="สร้างเมื่อ" value={formatDateTime(detail.createdAt)} />
                      )}
                      {detail.updatedAt && (
                        <Field label="แก้ไขล่าสุด" value={formatDateTime(detail.updatedAt)} />
                      )}
                    </dl>
                  )}
                </div>
              )}
            </div>

            {/* ---- Sticky footer ---- */}
            <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-card/95 px-7 py-3.5 backdrop-blur">
              <Button type="button" variant="outline" onClick={onClose}>
                ปิด
              </Button>
              {onEdit && (
                <Button
                  type="button"
                  onClick={() => {
                    // Leaves read-only mode explicitly before any input exists.
                    onClose();
                    onEdit(detail);
                  }}
                >
                  <Pencil className="h-4 w-4" />
                  แก้ไขข้อมูล
                </Button>
              )}
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
