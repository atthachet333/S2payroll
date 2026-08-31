import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { employeeApi, payrollApi, settingsApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { useAuth } from '@/features/auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Switch,
  TableSkeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { formatDate, formatDateTime } from '@/utils/format';
import type { PayrollSetting } from '@/types';

const GROUP_LABELS: Record<string, string> = {
  ATTENDANCE: 'กฎการลงเวลา',
  OT: 'กฎการทำงานล่วงเวลา',
  DEDUCTION: 'กฎการหักเงิน',
  SOCIAL_SECURITY: 'ประกันสังคม',
  TAX: 'ภาษี',
  PAYROLL: 'กฎเงินเดือน',
  GOOGLE_SHEETS: 'Google Sheets',
};

export default function SettingsPage() {
  const { can, user } = useAuth();
  const canWrite = can('settings:write');

  return (
    <div>
      <PageHeader title="ตั้งค่าระบบ" description="ข้อมูลบริษัท เวลาและวันทำงาน วันหยุด ผู้ใช้งาน และการเชื่อมต่อระบบ" />

      <Tabs defaultValue="company">
        <TabsList className="flex-wrap">
          <TabsTrigger value="company">บริษัท</TabsTrigger>
          <TabsTrigger value="org">แผนก / ตำแหน่ง</TabsTrigger>
          <TabsTrigger value="rules">เวลาและวันทำงาน</TabsTrigger>
          <TabsTrigger value="schedules">ตารางเวลาที่เริ่มใช้ตามวันที่</TabsTrigger>
          <TabsTrigger value="holidays">วันหยุด</TabsTrigger>
          {can('user:read') && <TabsTrigger value="users">ผู้ใช้งาน / สิทธิ์</TabsTrigger>}
          {can('audit:read') && <TabsTrigger value="audit">บันทึกการตรวจสอบ</TabsTrigger>}
        </TabsList>

        <TabsContent value="company">
          <CompanySettings canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="org">
          <OrgSettings canWrite={canWrite} />
        </TabsContent>
        <TabsContent value="rules">
          <RuleSettings canWrite={canWrite} groups={['ATTENDANCE', 'GOOGLE_SHEETS']} />
        </TabsContent>
        <TabsContent value="schedules"><WorkScheduleSettings canWrite={canWrite} /></TabsContent>
        <TabsContent value="holidays">
          <HolidaySettings canWrite={canWrite} />
        </TabsContent>
        {can('user:read') && (
          <TabsContent value="users">
            <UserSettings canWrite={can('user:write')} currentUserId={user?.id ?? ''} />
          </TabsContent>
        )}
        {can('audit:read') && (
          <TabsContent value="audit">
            <AuditSettings />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function WorkScheduleSettings({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    name: 'เวลาทำงานปกติ', effectiveFrom: '', effectiveTo: '',
    workingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    workStartTime: '08:00', workEndTime: '17:00', flexArrivalMinutes: 30,
  });
  const query = useQuery({ queryKey: ['work-schedules'], queryFn: settingsApi.listWorkSchedules });
  const mutation = useMutation({
    mutationFn: () => settingsApi.createWorkSchedule({ ...form, effectiveTo: form.effectiveTo || null }),
    onSuccess: () => { toast.success('เพิ่มตารางเวลาทำงานแล้ว'); setOpen(false); void queryClient.invalidateQueries({ queryKey: ['work-schedules'] }); },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const dayOptions = [['MON','จ'],['TUE','อ'],['WED','พ'],['THU','พฤ'],['FRI','ศ'],['SAT','ส'],['SUN','อา']];
  return <Card>
    <CardHeader className="flex-row items-center justify-between"><div><CardTitle>ตารางเวลาทำงาน</CardTitle><CardDescription>กำหนดวันที่เริ่มใช้เพื่อรักษากฎของข้อมูลย้อนหลัง ระบบจะไม่แก้ประวัติเดิมอัตโนมัติ</CardDescription></div>{canWrite && <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" />เพิ่มตาราง</Button>}</CardHeader>
    <CardContent>
      {query.isLoading ? <TableSkeleton rows={3} cols={4} /> : query.data?.length ? <div className="space-y-2">{query.data.map((item) => <div key={item.id} className="grid gap-2 rounded-lg border border-border px-3.5 py-3 text-sm md:grid-cols-4"><span className="font-medium">{item.name}</span><span>{formatDate(item.effectiveFrom)}{item.effectiveTo ? ` – ${formatDate(item.effectiveTo)}` : ' เป็นต้นไป'}</span><span>{item.workStartTime}–{item.workEndTime}</span><span className="text-muted-foreground">{item.workingDays.replaceAll(',', ' · ')} · ผ่อนผัน {item.flexArrivalMinutes} นาที</span></div>)}</div> : <EmptyState title="ยังไม่มีตารางเวลาที่กำหนดตามวันที่" description="ค่าการลงเวลาปัจจุบันยังคงใช้จากการตั้งค่าระบบ" />}
    </CardContent>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent title="เพิ่มตารางเวลาทำงาน" className="max-w-lg"><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <Field label="ชื่อ" required><Input value={form.name} onChange={(e) => setForm((f) => ({...f,name:e.target.value}))} required /></Field>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="เริ่มใช้วันที่" required><Input type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({...f,effectiveFrom:e.target.value}))} required /></Field><Field label="สิ้นสุดวันที่"><Input type="date" value={form.effectiveTo} onChange={(e) => setForm((f) => ({...f,effectiveTo:e.target.value}))} /></Field></div>
      <div className="grid grid-cols-7 gap-1">{dayOptions.map(([token,label]) => <label key={token} className="flex flex-col items-center gap-1 rounded-lg border border-border p-2 text-xs"><Switch checked={form.workingDays.includes(token)} onCheckedChange={(checked) => setForm((f) => ({...f,workingDays:checked?[...f.workingDays,token]:f.workingDays.filter((day)=>day!==token)}))}/>{label}</label>)}</div>
      <div className="grid gap-4 sm:grid-cols-3"><Field label="เวลาเริ่มงาน"><Input type="time" value={form.workStartTime} onChange={(e)=>setForm((f)=>({...f,workStartTime:e.target.value}))}/></Field><Field label="เวลาเลิกงาน"><Input type="time" value={form.workEndTime} onChange={(e)=>setForm((f)=>({...f,workEndTime:e.target.value}))}/></Field><Field label="ผ่อนผัน (นาที)"><Input type="number" min="0" value={form.flexArrivalMinutes} onChange={(e)=>setForm((f)=>({...f,flexArrivalMinutes:Number(e.target.value)}))}/></Field></div>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={()=>setOpen(false)}>ยกเลิก</Button><Button type="submit" loading={mutation.isPending}>เพิ่ม</Button></div>
    </form></DialogContent></Dialog>
  </Card>;
}

// ---------------------------------------------------------------------------

function CompanySettings({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['company'],
    queryFn: settingsApi.getCompany,
  });

  const [form, setForm] = React.useState({
    name: '',
    nameEn: '',
    taxId: '',
    address: '',
    phone: '',
    email: '',
    ssoBranchNo: '',
  });

  React.useEffect(() => {
    if (data) {
      setForm({
        name: data.name ?? '',
        nameEn: data.nameEn ?? '',
        taxId: data.taxId ?? '',
        address: data.address ?? '',
        phone: data.phone ?? '',
        email: data.email ?? '',
        ssoBranchNo: data.ssoBranchNo ?? '',
      });
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: () => settingsApi.saveCompany(form),
    onSuccess: () => {
      toast.success('บันทึกข้อมูลบริษัทเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  if (isLoading) return <Card className="h-64 animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle>ข้อมูลบริษัท</CardTitle>
        <CardDescription>ข้อมูลนี้จะแสดงบนหัวสลิปเงินเดือน</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Field label="ชื่อบริษัท (ไทย)" required>
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              disabled={!canWrite}
              required
            />
          </Field>
          <Field label="ชื่อบริษัท (อังกฤษ)">
            <Input
              value={form.nameEn}
              onChange={(e) => set('nameEn', e.target.value)}
              disabled={!canWrite}
            />
          </Field>
          <Field label="เลขประจำตัวผู้เสียภาษี">
            <Input
              value={form.taxId}
              onChange={(e) => set('taxId', e.target.value)}
              disabled={!canWrite}
            />
          </Field>
          <Field label="สาขาประกันสังคม">
            <Input
              value={form.ssoBranchNo}
              onChange={(e) => set('ssoBranchNo', e.target.value)}
              disabled={!canWrite}
            />
          </Field>
          <Field label="เบอร์โทรศัพท์">
            <Input
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
              disabled={!canWrite}
            />
          </Field>
          <Field label="อีเมล">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              disabled={!canWrite}
            />
          </Field>
          <Field label="ที่อยู่" className="sm:col-span-2">
            <Textarea
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              disabled={!canWrite}
              rows={2}
            />
          </Field>

          {canWrite && (
            <div className="sm:col-span-2">
              <Button type="submit" loading={mutation.isPending}>
                <Save className="h-4 w-4" />
                บันทึก
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function OrgSettings({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [deptOpen, setDeptOpen] = React.useState(false);
  const [posOpen, setPosOpen] = React.useState(false);
  const [deptForm, setDeptForm] = React.useState({ code: '', name: '' });
  const [posForm, setPosForm] = React.useState({ code: '', name: '', departmentId: '' });

  const departments = useQuery({ queryKey: ['departments'], queryFn: settingsApi.listDepartments });
  const positions = useQuery({ queryKey: ['positions'], queryFn: settingsApi.listPositions });

  const createDept = useMutation({
    mutationFn: () => settingsApi.createDepartment(deptForm),
    onSuccess: () => {
      toast.success('เพิ่มแผนกเรียบร้อยแล้ว');
      setDeptOpen(false);
      setDeptForm({ code: '', name: '' });
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const createPos = useMutation({
    mutationFn: () =>
      settingsApi.createPosition({ ...posForm, departmentId: posForm.departmentId || null }),
    onSuccess: () => {
      toast.success('เพิ่มตำแหน่งเรียบร้อยแล้ว');
      setPosOpen(false);
      setPosForm({ code: '', name: '', departmentId: '' });
      void queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>แผนก</CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => setDeptOpen(true)}>
              <Plus className="h-4 w-4" />
              เพิ่ม
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0 pt-3">
          {departments.isLoading ? (
            <TableSkeleton rows={4} cols={3} />
          ) : departments.data?.length === 0 ? (
            <EmptyState title="ยังไม่มีแผนก" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>รหัส</th>
                  <th>ชื่อแผนก</th>
                  <th className="text-right">พนักงาน</th>
                </tr>
              </thead>
              <tbody>
                {departments.data?.map((d) => (
                  <tr key={d.id}>
                    <td className="font-medium">{d.code}</td>
                    <td>{d.name}</td>
                    <td className="num">{d._count?.employees ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>ตำแหน่ง</CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => setPosOpen(true)}>
              <Plus className="h-4 w-4" />
              เพิ่ม
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0 pt-3">
          {positions.isLoading ? (
            <TableSkeleton rows={4} cols={3} />
          ) : positions.data?.length === 0 ? (
            <EmptyState title="ยังไม่มีตำแหน่ง" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>รหัส</th>
                  <th>ชื่อตำแหน่ง</th>
                  <th>แผนก</th>
                </tr>
              </thead>
              <tbody>
                {positions.data?.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium">{p.code}</td>
                    <td>{p.name}</td>
                    <td className="text-muted-foreground">{p.department?.name ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={deptOpen} onOpenChange={setDeptOpen}>
        <DialogContent title="เพิ่มแผนก" className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createDept.mutate();
            }}
            className="space-y-4"
          >
            <Field label="รหัสแผนก" required>
              <Input
                value={deptForm.code}
                onChange={(e) => setDeptForm((f) => ({ ...f, code: e.target.value }))}
                required
              />
            </Field>
            <Field label="ชื่อแผนก" required>
              <Input
                value={deptForm.name}
                onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDeptOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" loading={createDept.isPending}>
                เพิ่ม
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={posOpen} onOpenChange={setPosOpen}>
        <DialogContent title="เพิ่มตำแหน่ง" className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createPos.mutate();
            }}
            className="space-y-4"
          >
            <Field label="รหัสตำแหน่ง" required>
              <Input
                value={posForm.code}
                onChange={(e) => setPosForm((f) => ({ ...f, code: e.target.value }))}
                required
              />
            </Field>
            <Field label="ชื่อตำแหน่ง" required>
              <Input
                value={posForm.name}
                onChange={(e) => setPosForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </Field>
            <Field label="แผนก">
              <Select
                value={posForm.departmentId}
                onChange={(e) => setPosForm((f) => ({ ...f, departmentId: e.target.value }))}
              >
                <option value="">- ไม่ระบุ -</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setPosOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" loading={createPos.isPending}>
                เพิ่ม
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Payroll rules editor. Every value the calculation engine reads is editable
 * here, which is why no rate or threshold is hardcoded in the backend.
 */
export function RuleSettings({ canWrite, groups, keys }: { canWrite: boolean; groups?: string[]; keys?: string[] }) {
  const queryClient = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => settingsApi.list(),
  });

  const [dirty, setDirty] = React.useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: () =>
      settingsApi.update(Object.entries(dirty).map(([key, value]) => ({ key, value }))),
    onSuccess: () => {
      toast.success('บันทึกการตั้งค่าเรียบร้อยแล้ว');
      setDirty({});
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  if (isLoading) return <Card className="h-96 animate-pulse" />;

  const grouped = data.filter((setting) =>
    setting.key !== 'COUNT_WEEKEND_AS_WORKDAY' && (!groups || groups.includes(setting.group)) && (!keys || keys.includes(setting.key))
  ).reduce<Record<string, PayrollSetting[]>>((acc, setting) => {
    (acc[setting.group] ??= []).push(setting);
    return acc;
  }, {});

  const valueOf = (setting: PayrollSetting) => dirty[setting.key] ?? setting.value;
  const change = (key: string, value: string) => setDirty((d) => ({ ...d, [key]: value }));

  return (
    <div className="space-y-4">
      {Object.keys(dirty).length > 0 && canWrite && (
        <div className="sticky top-20 z-20 flex items-center justify-between rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
          <span className="text-sm text-warning-fg">
            มีการเปลี่ยนแปลง {Object.keys(dirty).length} รายการที่ยังไม่ได้บันทึก
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDirty({})}>
              ยกเลิก
            </Button>
            <Button size="sm" loading={mutation.isPending} onClick={() => mutation.mutate()}>
              <Save className="h-4 w-4" />
              บันทึก
            </Button>
          </div>
        </div>
      )}

      {Object.entries(grouped).map(([group, settings]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{GROUP_LABELS[group] ?? group}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {settings.map((setting) => (
              <Field
                key={setting.key}
                label={setting.label}
                hint={setting.description ?? undefined}
              >
                {setting.key === 'WORKING_DAYS' ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ['MON', 'จันทร์'], ['TUE', 'อังคาร'], ['WED', 'พุธ'], ['THU', 'พฤหัสบดี'],
                      ['FRI', 'ศุกร์'], ['SAT', 'เสาร์'], ['SUN', 'อาทิตย์'],
                    ].map(([token, label]) => {
                      const selected = new Set(valueOf(setting).split(',').filter(Boolean));
                      return (
                        <label key={token} className="flex items-center gap-2 rounded-lg border border-border px-2 py-2 text-xs">
                          <Switch
                            checked={selected.has(token)}
                            disabled={!canWrite}
                            onCheckedChange={(checked) => {
                              if (checked) selected.add(token); else selected.delete(token);
                              const order = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
                              change(setting.key, order.filter((day) => selected.has(day)).join(','));
                            }}
                          />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                ) : setting.valueType === 'BOOLEAN' ? (
                  <div className="flex h-10 items-center">
                    <Switch
                      checked={valueOf(setting) === 'true'}
                      disabled={!canWrite}
                      onCheckedChange={(checked) => change(setting.key, String(checked))}
                    />
                  </div>
                ) : setting.valueType === 'TIME' ? (
                  <Input
                    type="time"
                    value={valueOf(setting)}
                    disabled={!canWrite}
                    onChange={(e) => change(setting.key, e.target.value)}
                  />
                ) : setting.valueType === 'JSON' ? (
                  <Textarea
                    value={valueOf(setting)}
                    disabled={!canWrite}
                    rows={4}
                    className="font-mono text-xs"
                    onChange={(e) => change(setting.key, e.target.value)}
                  />
                ) : (
                  <Input
                    type={
                      setting.valueType === 'NUMBER' || setting.valueType === 'DECIMAL'
                        ? 'number'
                        : 'text'
                    }
                    step={setting.valueType === 'DECIMAL' ? '0.01' : '1'}
                    value={valueOf(setting)}
                    disabled={!canWrite}
                    onChange={(e) => change(setting.key, e.target.value)}
                  />
                )}
              </Field>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HolidaySettings({ canWrite }: { canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const emptyForm = { date: '', name: '', type: 'COMPANY_HOLIDAY' as const, note: '', isPaid: true };
  const [form, setForm] = React.useState<{ date: string; name: string; type: 'PUBLIC_HOLIDAY' | 'COMPANY_HOLIDAY'; note: string; isPaid: boolean }>(emptyForm);

  const { data = [], isLoading } = useQuery({
    queryKey: ['holidays'],
    queryFn: settingsApi.listHolidays,
  });

  const saveMutation = useMutation({
    mutationFn: () => editing
      ? settingsApi.updateHoliday(editing, form)
      : settingsApi.createHoliday(form),
    onSuccess: () => {
      toast.success(editing ? 'แก้ไขวันหยุดเรียบร้อยแล้ว' : 'เพิ่มวันหยุดเรียบร้อยแล้ว');
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => settingsApi.deleteHoliday(deleting!),
    onSuccess: () => {
      toast.success('ลบวันหยุดเรียบร้อยแล้ว');
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['holidays'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle>วันหยุดนักขัตฤกษ์</CardTitle>
          <CardDescription>
            วันที่กำหนดไว้ที่นี่จะไม่นับเป็นวันขาดงาน และการทำงานในวันนั้นจะคิดเป็น OT วันหยุด
          </CardDescription>
        </div>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            เพิ่มวันหยุด
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0 pt-3">
        {isLoading ? (
          <TableSkeleton rows={4} cols={3} />
        ) : data.length === 0 ? (
          <EmptyState title="ยังไม่มีวันหยุดในระบบ" />
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>วันที่</th>
                <th>ชื่อวันหยุด</th>
                <th>ประเภท</th>
                <th>หมายเหตุ</th>
                <th>ได้รับค่าจ้าง</th>
                <th className="w-[96px]" />
              </tr>
            </thead>
            <tbody>
              {data.map((holiday) => (
                <tr key={holiday.id}>
                  <td>{formatDate(holiday.date)}</td>
                  <td className="font-medium">{holiday.name}</td>
                  <td><Badge variant={holiday.type === 'PUBLIC_HOLIDAY' ? 'danger' : 'info'}>{holiday.type === 'PUBLIC_HOLIDAY' ? 'วันหยุดราชการ' : 'วันหยุดบริษัท'}</Badge></td>
                  <td className="text-muted-foreground">{holiday.note || '-'}</td>
                  <td>
                    <Badge variant={holiday.isPaid ? 'success' : 'secondary'}>
                      {holiday.isPaid ? 'ได้รับ' : 'ไม่ได้รับ'}
                    </Badge>
                  </td>
                  <td>
                    {canWrite && (
                      <div className="flex justify-center gap-1"><Button
                        variant="ghost" size="icon" aria-label="แก้ไข"
                        onClick={() => {
                          setEditing(holiday.id);
                          setForm({ date: holiday.date.slice(0, 10), name: holiday.name, type: holiday.type, note: holiday.note ?? '', isPaid: holiday.isPaid });
                          setOpen(true);
                        }}
                      ><Pencil className="h-4 w-4" /></Button><Button
                        variant="ghost"
                        size="icon"
                        className="text-danger hover:bg-danger-soft"
                        onClick={() => setDeleting(holiday.id)}
                        aria-label="ลบ"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button></div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) { setEditing(null); setForm(emptyForm); } }}>
        <DialogContent title={editing ? 'แก้ไขวันหยุด' : 'เพิ่มวันหยุด'} className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveMutation.mutate();
            }}
            className="space-y-4"
          >
            <Field label="วันที่" required>
              <Input
                type="date"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                required
              />
            </Field>
            <Field label="ชื่อวันหยุด" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="เช่น วันสงกรานต์"
                required
              />
            </Field>
            <Field label="ประเภท" required>
              <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as typeof f.type }))}>
                <option value="PUBLIC_HOLIDAY">วันหยุดราชการ</option>
                <option value="COMPANY_HOLIDAY">วันหยุดบริษัท</option>
              </Select>
            </Field>
            <Field label="หมายเหตุ">
              <Textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} rows={2} />
            </Field>
            <div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-2.5">
              <span className="text-sm font-medium">ได้รับค่าจ้างในวันหยุดนี้</span>
              <Switch
                checked={form.isPaid}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, isPaid: checked }))}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" loading={saveMutation.isPending}>
                {editing ? 'บันทึก' : 'เพิ่ม'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="ลบวันหยุด"
        description="การลบวันหยุดจะมีผลกับการคำนวณรอบเงินเดือนที่ยังไม่ถูกล็อก"
        confirmLabel="ลบ"
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------

function UserSettings({
  canWrite,
  currentUserId,
}: {
  canWrite: boolean;
  currentUserId: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    roleCode: 'VIEWER',
  });

  const users = useQuery({ queryKey: ['users'], queryFn: settingsApi.listUsers });
  const roles = useQuery({ queryKey: ['roles'], queryFn: settingsApi.listRoles });

  const createMutation = useMutation({
    mutationFn: () => settingsApi.createUser(form),
    onSuccess: () => {
      toast.success('สร้างผู้ใช้งานเรียบร้อยแล้ว');
      setOpen(false);
      setForm({ email: '', password: '', firstName: '', lastName: '', roleCode: 'VIEWER' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      settingsApi.updateUser(id, { isActive }),
    onSuccess: () => {
      toast.success('อัปเดตสถานะผู้ใช้งานเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  });

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>ผู้ใช้งาน</CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              เพิ่มผู้ใช้งาน
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0 pt-3">
          {users.isLoading ? (
            <TableSkeleton rows={4} cols={5} />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>ชื่อ-นามสกุล</th>
                  <th>อีเมล</th>
                  <th>สิทธิ์</th>
                  <th>เข้าใช้งานล่าสุด</th>
                  <th>ใช้งาน</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id}>
                    <td className="font-medium">
                      {u.firstName} {u.lastName}
                      {u.id === currentUserId && (
                        <Badge variant="info" className="ml-2">
                          คุณ
                        </Badge>
                      )}
                    </td>
                    <td className="text-muted-foreground">{u.email}</td>
                    <td>
                      <Badge variant="outline">{u.roleLabel ?? u.role.code}</Badge>
                    </td>
                    <td className="text-muted-foreground">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'ยังไม่เคยเข้าใช้'}
                    </td>
                    <td>
                      <Switch
                        checked={u.isActive}
                        disabled={!canWrite || u.id === currentUserId}
                        onCheckedChange={(checked) =>
                          toggleMutation.mutate({ id: u.id, isActive: checked })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>สิทธิ์การใช้งานตามบทบาท</CardTitle>
          <CardDescription>กำหนดไว้ในระบบ ไม่สามารถแก้ไขผ่านหน้าจอได้</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {roles.data?.map((role) => (
            <div key={role.id} className="rounded-lg border border-border p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-medium">{role.label}</span>
                <Badge variant="secondary">{role.code}</Badge>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {role.permissions.map((permission) => (
                  <span
                    key={permission}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                  >
                    {permission}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="เพิ่มผู้ใช้งาน" className="max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="ชื่อ" required>
                <Input
                  value={form.firstName}
                  onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                  required
                />
              </Field>
              <Field label="นามสกุล" required>
                <Input
                  value={form.lastName}
                  onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                  required
                />
              </Field>
            </div>
            <Field label="อีเมล" required>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </Field>
            <Field label="รหัสผ่านเริ่มต้น" required hint="อย่างน้อย 8 ตัวอักษร">
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                minLength={8}
                required
              />
            </Field>
            <Field label="สิทธิ์การใช้งาน" required>
              <Select
                value={form.roleCode}
                onChange={(e) => setForm((f) => ({ ...f, roleCode: e.target.value }))}
              >
                {roles.data?.map((role) => (
                  <option key={role.code} value={role.code}>
                    {role.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" loading={createMutation.isPending}>
                สร้างผู้ใช้งาน
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Actions worth filtering by, grouped so the list stays readable. */
const AUDIT_ACTIONS: { group: string; actions: [string, string][] }[] = [
  {
    group: 'รอบเงินเดือน',
    actions: [
      ['PAYROLL_PERIOD_CREATE', 'สร้างรอบ'],
      ['PAYROLL_CALCULATE', 'คำนวณ'],
      ['PAYROLL_SUBMIT_REVIEW', 'ส่งตรวจสอบ'],
      ['PAYROLL_APPROVE', 'อนุมัติ'],
      ['PAYROLL_MARK_PAID', 'บันทึกจ่าย'],
      ['PAYROLL_LOCK', 'ล็อก'],
      ['PAYROLL_UNLOCK', 'ปลดล็อก'],
      ['PAYROLL_ADJUST', 'ปรับปรุงเงินเดือน'],
    ],
  },
  {
    group: 'สลิปเงินเดือน',
    actions: [
      ['PAYSLIP_GENERATE', 'ออกสลิป'],
      ['PAYSLIP_PDF_DOWNLOAD', 'ดาวน์โหลด PDF'],
      ['PAYSLIP_BULK_EXPORT', 'ดาวน์โหลดทั้งหมด'],
    ],
  },
  {
    group: 'การลงเวลา',
    actions: [
      ['ATTENDANCE_CORRECT', 'แก้ไขเวลาทำงาน'],
      ['SHEET_SYNC', 'ซิงค์ Google Sheets'],
    ],
  },
  {
    group: 'ผู้ใช้และการตั้งค่า',
    actions: [
      ['LOGIN', 'เข้าสู่ระบบ'],
      ['PASSWORD_CHANGE', 'เปลี่ยนรหัสผ่าน'],
      ['USER_CREATE', 'สร้างผู้ใช้'],
      ['USER_UPDATE', 'แก้ไขผู้ใช้'],
      ['USER_FORCE_PASSWORD_CHANGE', 'บังคับเปลี่ยนรหัสผ่าน'],
      ['SETTINGS_UPDATE', 'แก้ไขการตั้งค่า'],
    ],
  },
];

/**
 * Audit log viewer.
 *
 * Shows only what an auditor needs: who, what, when, against which target, and
 * why. Raw old/new payloads are summarised rather than dumped, so nothing
 * incidental leaks into the page.
 */
function AuditSettings() {
  const [page, setPage] = React.useState(1);
  const [entity, setEntity] = React.useState('');
  const [action, setAction] = React.useState('');
  const [userId, setUserId] = React.useState('');
  const [entityId, setEntityId] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const users = useQuery({ queryKey: ['users'], queryFn: settingsApi.listUsers });
  const periods = useQuery({ queryKey: ['payroll-periods'], queryFn: payrollApi.listPeriods });
  const employees = useQuery({
    queryKey: ['employees', 'audit-filter'],
    queryFn: () => employeeApi.list({ page: 1, pageSize: 200 }),
  });

  const resetPage = () => setPage(1);

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', page, entity, action, userId, entityId, from, to],
    queryFn: () =>
      settingsApi.auditLogs({
        page,
        pageSize: 25,
        ...(entity ? { entity } : {}),
        ...(action ? { action } : {}),
        ...(userId ? { userId } : {}),
        ...(entityId ? { entityId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      }),
  });

  const clearAll = () => {
    setEntity('');
    setAction('');
    setUserId('');
    setEntityId('');
    setFrom('');
    setTo('');
    setPage(1);
  };

  const hasFilters = Boolean(entity || action || userId || entityId || from || to);

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>บันทึกการตรวจสอบ</CardTitle>
        <CardDescription>
          บันทึกการกระทำสำคัญทั้งหมด เช่น การแก้ไขเวลาทำงาน การปรับเงินเดือน และการล็อก/ปลดล็อกรอบ
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-3">
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
          <Field label="ตั้งแต่วันที่">
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                resetPage();
              }}
            />
          </Field>
          <Field label="ถึงวันที่">
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                resetPage();
              }}
            />
          </Field>
          <Field label="ผู้ใช้งาน">
            <Select
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                resetPage();
              }}
            >
              <option value="">ทุกคน</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.firstName} {u.lastName} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="การกระทำ">
            <Select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                resetPage();
              }}
            >
              <option value="">ทุกการกระทำ</option>
              {AUDIT_ACTIONS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.actions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="ประเภทข้อมูล">
            <Select
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value);
                resetPage();
              }}
            >
              <option value="">ทั้งหมด</option>
              <option value="PayrollPeriod">รอบเงินเดือน</option>
              <option value="PayrollEmployee">เงินเดือนพนักงาน</option>
              <option value="AttendanceRecord">การลงเวลา</option>
              <option value="Employee">พนักงาน</option>
              <option value="Payslip">สลิปเงินเดือน</option>
              <option value="User">ผู้ใช้งาน</option>
              <option value="PayrollSetting">การตั้งค่า</option>
              <option value="GoogleSheetSync">การซิงค์ข้อมูล</option>
            </Select>
          </Field>
          <Field label="รอบเงินเดือน">
            <Select
              value={entity === 'PayrollPeriod' ? entityId : ''}
              onChange={(e) => {
                setEntity(e.target.value ? 'PayrollPeriod' : '');
                setEntityId(e.target.value);
                resetPage();
              }}
            >
              <option value="">ทุกรอบ</option>
              {periods.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="พนักงาน">
            <Select
              value={entity === 'Employee' ? entityId : ''}
              onChange={(e) => {
                setEntity(e.target.value ? 'Employee' : '');
                setEntityId(e.target.value);
                resetPage();
              }}
            >
              <option value="">ทุกคน</option>
              {employees.data?.items.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employeeCode} {emp.firstName} {emp.lastName}
                </option>
              ))}
            </Select>
          </Field>
          {hasFilters && (
            <div className="flex items-end">
              <Button variant="outline" onClick={clearAll}>
                ล้างตัวกรอง
              </Button>
            </div>
          )}
        </div>
      </CardContent>

      {isLoading ? (
        <TableSkeleton rows={8} cols={5} />
      ) : data && data.items.length === 0 ? (
        <EmptyState title="ยังไม่มีบันทึกการตรวจสอบ" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>เวลา</th>
                  <th>ผู้ใช้งาน</th>
                  <th>การกระทำ</th>
                  <th>ข้อมูล</th>
                  <th>เหตุผล / รายละเอียด</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((log) => (
                  <tr key={log.id}>
                    <td className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(log.createdAt)}
                    </td>
                    <td>{log.userEmail ?? 'ระบบ'}</td>
                    <td>
                      <Badge variant="outline">{log.action}</Badge>
                    </td>
                    <td className="text-muted-foreground">{log.entity}</td>
                    <td className="max-w-md truncate text-xs text-muted-foreground">
                      {log.reason ??
                        (log.newValue ? JSON.stringify(log.newValue) : '-')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data && (
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </Card>
  );
}
