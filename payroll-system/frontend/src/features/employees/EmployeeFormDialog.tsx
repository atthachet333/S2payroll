import * as React from 'react';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { employeeApi, settingsApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { formatIsoDate } from '@/utils/format';
import type { Employee } from '@/types';

interface FormState {
  employeeCode: string;
  firstName: string;
  lastName: string;
  nickname: string;
  nationalId: string;
  email: string;
  phone: string;
  departmentId: string;
  positionId: string;
  employmentType: string;
  startDate: string;
  endDate: string;
  baseSalary: string;
  bankName: string;
  bankAccount: string;
  taxId: string;
  socialSecurity: string;
  ssoEnabled: boolean;
  taxEnabled: boolean;
  otEligible: boolean;
  attendanceRequired: boolean;
  leaveTrackingRequired: boolean;
  status: string;
  note: string;
  salaryChangeReason: string;
  payProfileAmount: string;
  payEffectiveFrom: string;
}

const emptyForm = (): FormState => ({
  employeeCode: '',
  firstName: '',
  lastName: '',
  nickname: '',
  nationalId: '',
  email: '',
  phone: '',
  departmentId: '',
  positionId: '',
  employmentType: 'MONTHLY',
  startDate: formatIsoDate(new Date()),
  endDate: '',
  baseSalary: '',
  bankName: '',
  bankAccount: '',
  taxId: '',
  socialSecurity: '',
  ssoEnabled: true,
  taxEnabled: true,
  otEligible: true,
  attendanceRequired: true,
  leaveTrackingRequired: true,
  status: 'ACTIVE',
  note: '',
  salaryChangeReason: '',
  payProfileAmount: '',
  payEffectiveFrom: '',
});

const fromEmployee = (e: Employee): FormState => ({
  employeeCode: e.employeeCode,
  firstName: e.firstName,
  lastName: e.lastName,
  nickname: e.nickname ?? '',
  nationalId: e.nationalId ?? '',
  email: e.email ?? '',
  phone: e.phone ?? '',
  departmentId: e.departmentId ?? '',
  positionId: e.positionId ?? '',
  employmentType: e.employmentType,
  startDate: formatIsoDate(e.startDate),
  endDate: e.endDate ? formatIsoDate(e.endDate) : '',
  baseSalary: e.baseSalary,
  bankName: e.bankName ?? '',
  bankAccount: e.bankAccount ?? '',
  taxId: e.taxId ?? '',
  socialSecurity: e.socialSecurity ?? '',
  ssoEnabled: e.ssoEnabled,
  taxEnabled: e.taxEnabled,
  otEligible: e.otEligible,
  attendanceRequired: e.attendanceRequired,
  leaveTrackingRequired: e.leaveTrackingRequired,
  status: e.status,
  note: e.note ?? '',
  salaryChangeReason: '',
  payProfileAmount: '',
  payEffectiveFrom: formatIsoDate(new Date()),
});

export default function EmployeeFormDialog({
  open,
  onOpenChange,
  employee,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee?: Employee | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(employee);
  const [form, setForm] = React.useState<FormState>(emptyForm);
  const [error, setError] = React.useState<string | null>(null);

  // Reset the form whenever the dialog opens for a different subject.
  React.useEffect(() => {
    if (open) {
      setForm(employee ? fromEmployee(employee) : emptyForm());
      setError(null);
    }
  }, [open, employee]);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: settingsApi.listDepartments,
    enabled: open,
  });
  const { data: positions = [] } = useQuery({
    queryKey: ['positions'],
    queryFn: settingsApi.listPositions,
    enabled: open,
  });
  const payProfilesQuery = useQuery({
    queryKey: ['employee-pay-profiles', employee?.id],
    queryFn: () => employeeApi.payProfiles(employee!.id),
    enabled: open && Boolean(employee?.id),
  });

  React.useEffect(() => {
    if (!open || !employee || !payProfilesQuery.data) return;
    const active = payProfilesQuery.data.find((profile) => profile.isActive &&
      !dayjs().startOf('day').isBefore(dayjs(profile.effectiveFrom), 'day') &&
      (!profile.effectiveTo || !dayjs().startOf('day').isAfter(dayjs(profile.effectiveTo), 'day')));
    setForm((current) => ({
      ...current,
      payProfileAmount: active
        ? String(active.payType === 'MONTHLY' ? active.monthlySalary ?? '' : active.hourlyRate ?? '')
        : Number(employee.baseSalary) > 0 ? employee.baseSalary : '',
      payEffectiveFrom: active ? formatIsoDate(active.effectiveFrom) : '',
    }));
  }, [open, employee, payProfilesQuery.data]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const salaryChanged = isEdit && employee ? form.baseSalary !== employee.baseSalary : false;

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        firstName: form.firstName,
        lastName: form.lastName,
        nickname: form.nickname || null,
        nationalId: form.nationalId || null,
        email: form.email || null,
        phone: form.phone || null,
        departmentId: form.departmentId || null,
        positionId: form.positionId || null,
        employmentType: form.employmentType,
        startDate: form.startDate,
        endDate: form.endDate || null,
        baseSalary: form.baseSalary || '0',
        bankName: form.bankName || null,
        bankAccount: form.bankAccount || null,
        taxId: form.taxId || null,
        socialSecurity: form.socialSecurity || null,
        ssoEnabled: form.ssoEnabled,
        taxEnabled: form.taxEnabled,
        otEligible: form.otEligible,
        attendanceRequired: form.attendanceRequired,
        leaveTrackingRequired: form.leaveTrackingRequired,
        status: form.status,
        note: form.note || null,
      };

      if (isEdit && employee) {
        if (salaryChanged && form.salaryChangeReason) {
          payload.salaryChangeReason = form.salaryChangeReason;
        }
        const saved = await employeeApi.update(employee.id, payload);
        const existingProfile = payProfilesQuery.data?.find((profile) => profile.isActive && formatIsoDate(profile.effectiveFrom) === form.payEffectiveFrom);
        const existingAmount = existingProfile
          ? String(existingProfile.payType === 'MONTHLY' ? existingProfile.monthlySalary ?? '' : existingProfile.hourlyRate ?? '')
          : '';
        if (form.payProfileAmount && form.payEffectiveFrom && (!existingProfile || Number(existingAmount) !== Number(form.payProfileAmount))) {
          const monthly = ['MONTHLY', 'CONTRACT'].includes(form.employmentType);
          await employeeApi.createPayProfile(saved.id, {
            payType: monthly ? 'MONTHLY' : 'HOURLY',
            monthlySalary: monthly ? form.payProfileAmount : null,
            hourlyRate: monthly ? null : form.payProfileAmount,
            effectiveFrom: form.payEffectiveFrom,
            isActive: true,
          });
        }
        return saved;
      }
      const saved = await employeeApi.create({ ...payload, employeeCode: form.employeeCode });
      if (form.payProfileAmount) {
        const monthly = ['MONTHLY', 'CONTRACT'].includes(form.employmentType);
        await employeeApi.createPayProfile(saved.id, {
          payType: monthly ? 'MONTHLY' : 'HOURLY',
          monthlySalary: monthly ? form.payProfileAmount : null,
          hourlyRate: monthly ? null : form.payProfileAmount,
          effectiveFrom: form.payEffectiveFrom,
          isActive: true,
        });
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(isEdit ? 'บันทึกข้อมูลพนักงานแล้ว' : 'เพิ่มพนักงานใหม่เรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
      void queryClient.invalidateQueries({ queryKey: ['employee'] });
      void queryClient.invalidateQueries({ queryKey: ['employee-pay-profiles'] });
      void queryClient.invalidateQueries({ queryKey: ['pay-configurations'] });
      onOpenChange(false);
    },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  };

  const filteredPositions = form.departmentId
    ? positions.filter((p) => !p.departmentId || p.departmentId === form.departmentId)
    : positions;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={isEdit ? 'แก้ไขข้อมูลพนักงาน' : 'เพิ่มพนักงานใหม่'}
        className="max-h-[90vh] max-w-3xl overflow-y-auto"
      >
        <form onSubmit={submit} className="space-y-4">
          <Tabs defaultValue="personal">
            <TabsList>
              <TabsTrigger value="personal">ข้อมูลส่วนตัว</TabsTrigger>
              <TabsTrigger value="employment">การจ้างงาน</TabsTrigger>
              <TabsTrigger value="payroll">การจ่ายเงิน</TabsTrigger>
            </TabsList>

            <TabsContent value="personal" className="grid gap-4 sm:grid-cols-2">
              <Field label="รหัสพนักงาน" required>
                <Input
                  value={form.employeeCode}
                  onChange={(e) => set('employeeCode', e.target.value)}
                  disabled={isEdit}
                  placeholder="S2A001"
                  required
                />
              </Field>
              <Field label="ชื่อเล่น">
                <Input value={form.nickname} onChange={(e) => set('nickname', e.target.value)} />
              </Field>
              <Field label="ชื่อ" required>
                <Input
                  value={form.firstName}
                  onChange={(e) => set('firstName', e.target.value)}
                  required
                />
              </Field>
              <Field label="นามสกุล" required>
                <Input
                  value={form.lastName}
                  onChange={(e) => set('lastName', e.target.value)}
                  required
                />
              </Field>
              <Field label="เลขบัตรประชาชน">
                <Input value={form.nationalId} onChange={(e) => set('nationalId', e.target.value)} />
              </Field>
              <Field label="เบอร์โทรศัพท์">
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
              <Field label="อีเมล" className="sm:col-span-2">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                />
              </Field>
            </TabsContent>

            <TabsContent value="employment" className="grid gap-4 sm:grid-cols-2">
              <Field label="แผนก">
                <Select
                  value={form.departmentId}
                  onChange={(e) => {
                    set('departmentId', e.target.value);
                    set('positionId', '');
                  }}
                >
                  <option value="">- ไม่ระบุ -</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="ตำแหน่ง">
                <Select value={form.positionId} onChange={(e) => set('positionId', e.target.value)}>
                  <option value="">- ไม่ระบุ -</option>
                  {filteredPositions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="ประเภทการจ้าง" required>
                <Select
                  value={form.employmentType}
                  onChange={(e) => set('employmentType', e.target.value)}
                >
                  <option value="MONTHLY">รายเดือน</option>
                  <option value="DAILY">รายวัน</option>
                  <option value="HOURLY">รายชั่วโมง</option>
                  <option value="CONTRACT">สัญญาจ้าง</option>
                </Select>
              </Field>
              <Field label="สถานะ">
                <Select value={form.status} onChange={(e) => set('status', e.target.value)}>
                  <option value="ACTIVE">ทำงานอยู่</option>
                  <option value="PROBATION">ทดลองงาน</option>
                  <option value="INACTIVE">ไม่ทำงานแล้ว</option>
                  <option value="TERMINATED">พ้นสภาพ</option>
                </Select>
              </Field>
              <Field label="วันที่เริ่มงาน" required>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => set('startDate', e.target.value)}
                  required
                />
              </Field>
              <Field label="วันที่สิ้นสุด">
                <Input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => set('endDate', e.target.value)}
                />
              </Field>
              <Field label="หมายเหตุ" className="sm:col-span-2">
                <Textarea value={form.note} onChange={(e) => set('note', e.target.value)} rows={2} />
              </Field>
            </TabsContent>

            <TabsContent value="payroll" className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 sm:col-span-2">
                <p className="text-sm font-medium">การตั้งค่าการจ่ายเงินแบบมีวันที่เริ่มใช้</p>
                <p className="mt-1 text-xs text-muted-foreground">กรอกเฉพาะเมื่อต้องการเพิ่มอัตราใหม่ ประวัติเดิมจะไม่ถูกเขียนทับ</p>
              </div>
              <Field
                label={
                  ['DAILY', 'HOURLY'].includes(form.employmentType)
                    ? 'อัตราค่าจ้าง (บาท/ชั่วโมง)'
                    : 'เงินเดือน (บาท/เดือน)'
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.payProfileAmount}
                  onChange={(e) => set('payProfileAmount', e.target.value)}
                  placeholder="เว้นว่างหากยังไม่กำหนดอัตราจริง"
                />
              </Field>
              <Field label="วันที่เริ่มใช้">
                <Input type="date" value={form.payEffectiveFrom} onChange={(e) => set('payEffectiveFrom', e.target.value)} required={Boolean(form.payProfileAmount)} />
              </Field>

              <Field label="ธนาคาร">
                <Input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} />
              </Field>
              <Field label="เลขที่บัญชี">
                <Input
                  value={form.bankAccount}
                  onChange={(e) => set('bankAccount', e.target.value)}
                />
              </Field>
              <Field label="เลขประจำตัวผู้เสียภาษี">
                <Input value={form.taxId} onChange={(e) => set('taxId', e.target.value)} />
              </Field>
              <Field label="เลขที่ประกันสังคม">
                <Input
                  value={form.socialSecurity}
                  onChange={(e) => set('socialSecurity', e.target.value)}
                />
              </Field>

              <div className="space-y-3 sm:col-span-2">
                <ToggleRow
                  label="หักประกันสังคม"
                  checked={form.ssoEnabled}
                  onChange={(v) => set('ssoEnabled', v)}
                />
                <ToggleRow
                  label="หักภาษี ณ ที่จ่าย"
                  checked={form.taxEnabled}
                  onChange={(v) => set('taxEnabled', v)}
                />
                <ToggleRow
                  label="มีสิทธิ์รับค่าล่วงเวลา (OT)"
                  checked={form.otEligible}
                  onChange={(v) => set('otEligible', v)}
                />
                <ToggleRow
                  label="ต้องลงเวลาเข้า-ออกงาน"
                  checked={form.attendanceRequired}
                  onChange={(v) => set('attendanceRequired', v)}
                />
                <ToggleRow
                  label="ต้องติดตามและตรวจสอบวันลา"
                  checked={form.leaveTrackingRequired}
                  onChange={(v) => set('leaveTrackingRequired', v)}
                />
              </div>
            </TabsContent>
          </Tabs>

          {error && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">{error}</p>
          )}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isEdit ? 'บันทึกการแก้ไข' : 'เพิ่มพนักงาน'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
