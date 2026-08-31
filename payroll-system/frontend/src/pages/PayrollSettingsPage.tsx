import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleDollarSign, Clock3, Landmark, ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorMessage } from '@/services/api';
import { employeeApi, settingsApi } from '@/services/endpoints';
import { useAuth } from '@/features/auth/AuthContext';
import { RuleSettings } from '@/pages/SettingsPage';
import { formatDate, formatMoney } from '@/utils/format';
import type { EmployeePayConfiguration } from '@/types';
import {
  Badge, Button, Card, CardContent, Dialog, DialogContent, ErrorState, Field,
  Input, PageHeader, TableSkeleton, Tabs, TabsContent, TabsList, TabsTrigger,
} from '@/components/ui';

export default function PayrollSettingsPage() {
  const { can } = useAuth();
  const canWrite = can('settings:write');
  return (
    <div>
      <PageHeader title="ตั้งค่าเงินเดือน" description="กฎค่าจ้าง รายการหัก OT ประกันสังคม ภาษี และรอบเงินเดือน" />
      <Tabs defaultValue="wage">
        <TabsList className="flex-wrap">
          <TabsTrigger value="wage">ค่าจ้างและเงินเดือน</TabsTrigger>
          <TabsTrigger value="deduction">หักมาสาย / ขาดงาน</TabsTrigger>
          <TabsTrigger value="ot">OT</TabsTrigger>
          <TabsTrigger value="statutory">ประกันสังคม / ภาษี</TabsTrigger>
          <TabsTrigger value="cycle">รอบเงินเดือน</TabsTrigger>
        </TabsList>
        <TabsContent value="wage">
          <Card><CardContent className="flex items-start gap-3 py-5 text-sm"><CircleDollarSign className="mt-0.5 h-5 w-5 text-primary" /><div><p className="font-medium">อัตราค่าจ้างกำหนดรายพนักงาน</p><p className="mt-1 text-muted-foreground">รายเดือนใช้เงินเดือนต่อเดือน รายวันใช้ค่าจ้างต่อชั่วโมงและนาทีทำงานจริง ทุกอัตราต้องมีวันที่เริ่มใช้</p></div></CardContent></Card>
          <div className="mt-4"><EmployeePayConfigurationTable canWrite={canWrite} /></div>
          <div className="mt-4"><RuleSettings canWrite={canWrite} keys={['PRORATE_NEW_HIRES', 'BLOCK_APPROVE_ON_MISSING_DATA']} /></div>
        </TabsContent>
        <TabsContent value="deduction"><Card className="mb-4"><CardContent className="flex items-start gap-3 py-5 text-sm"><ReceiptText className="mt-0.5 h-5 w-5 text-warning" /><div><p className="font-medium">สูตรการหักเงินที่ตรวจสอบได้</p><p className="mt-1 text-muted-foreground">มาสายปัดขึ้นตามช่วงชั่วโมง · รายเดือนคิดอัตราต่อชั่วโมงจากเงินเดือน ÷ ตัวหารวัน ÷ ชั่วโมงต่อวัน · ขาดงานคิดแยกต่างหาก</p></div></CardContent></Card><RuleSettings canWrite={canWrite} groups={['DEDUCTION']} /></TabsContent>
        <TabsContent value="ot"><RuleSettings canWrite={canWrite} groups={['OT']} /></TabsContent>
        <TabsContent value="statutory"><Card className="mb-4"><CardContent className="flex items-start gap-3 py-5 text-sm"><Landmark className="mt-0.5 h-5 w-5 text-primary" /><div><p className="font-medium">รายการตามกฎหมาย</p><p className="mt-1 text-muted-foreground">ตรวจสอบค่าตั้งต้นได้ที่นี่ ยอดรายบุคคลยังตรวจสอบในรายละเอียดเงินเดือน</p></div></CardContent></Card><RuleSettings canWrite={canWrite} groups={['SOCIAL_SECURITY', 'TAX']} /></TabsContent>
        <TabsContent value="cycle"><Card className="mb-4"><CardContent className="flex items-start gap-3 py-5 text-sm"><Clock3 className="mt-0.5 h-5 w-5 text-primary" /><div><p className="font-medium">รอบเงินเดือน</p><p className="mt-1 text-muted-foreground">ระบบเสนอช่วงวันที่จากค่าตั้งต้น ผู้มีสิทธิ์ยังตรวจสอบและแก้วันที่ของแต่ละรอบได้</p></div></CardContent></Card><RuleSettings canWrite={canWrite} keys={['PAYROLL_CYCLE_START_DAY', 'PAYROLL_CYCLE_END_DAY', 'PAYROLL_PAYMENT_DAY', 'PAYSLIP_PREFIX']} /></TabsContent>
      </Tabs>
    </div>
  );
}

function EmployeePayConfigurationTable({ canWrite }: { canWrite: boolean }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<EmployeePayConfiguration | null>(null);
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const query = useQuery({ queryKey: ['pay-configurations'], queryFn: settingsApi.payConfigurations });
  const mutation = useMutation({
    mutationFn: () => employeeApi.createPayProfile(selected!.id, {
      payType: selected!.employmentType === 'MONTHLY' || selected!.employmentType === 'CONTRACT' ? 'MONTHLY' : 'HOURLY',
      monthlySalary: selected!.employmentType === 'MONTHLY' || selected!.employmentType === 'CONTRACT' ? amount : null,
      hourlyRate: selected!.employmentType === 'DAILY' || selected!.employmentType === 'HOURLY' ? amount : null,
      effectiveFrom,
    }),
    onSuccess: () => { toast.success('บันทึกอัตราค่าจ้างแล้ว'); setSelected(null); setAmount(''); setEffectiveFrom(''); void client.invalidateQueries({ queryKey: ['pay-configurations'] }); void client.invalidateQueries({ queryKey: ['employee-pay-profiles'] }); void client.invalidateQueries({ queryKey: ['employee-summary'] }); void client.invalidateQueries({ queryKey: ['pre-payroll-check'] }); },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const open = (row: EmployeePayConfiguration) => {
    setSelected(row);
    setAmount(row.profile ? String(row.profile.payType === 'MONTHLY' ? row.profile.monthlySalary ?? '' : row.profile.hourlyRate ?? '') : row.paySource === 'LEGACY_BASE_SALARY' ? row.legacyBaseSalary : '');
    setEffectiveFrom(row.profile ? row.profile.effectiveFrom.slice(0, 10) : '');
  };
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-5 py-4"><h2 className="font-semibold">อัตราค่าจ้างพนักงาน</h2><p className="mt-1 text-sm text-muted-foreground">รายการที่ยังไม่พร้อมจะขัดขวางการคำนวณเงินเดือนจริง</p></div>
      {query.isLoading ? <TableSkeleton rows={6} cols={7} /> : query.isError ? <ErrorState message={apiErrorMessage(query.error)} onRetry={() => void query.refetch()} /> : (
        <div className="overflow-x-auto"><table className="data-table min-w-[900px]"><thead><tr><th>รหัส</th><th>ชื่อ</th><th>ประเภทพนักงาน</th><th>รูปแบบการจ่าย</th><th className="text-right">อัตรา</th><th>เริ่มใช้วันที่</th><th>สถานะ</th><th className="text-center">จัดการ</th></tr></thead><tbody>{query.data?.map((row) => {
          const profile = row.profile;
          const monthly = row.employmentType === 'MONTHLY' || row.employmentType === 'CONTRACT';
          return <tr key={row.id}><td className="font-medium">{row.employeeCode}</td><td>{row.firstName} {row.lastName}</td><td>{monthly ? 'รายเดือน' : row.employmentType === 'DAILY' ? 'รายวัน' : 'รายชั่วโมง'}</td><td>{row.exempt ? 'ยกเว้นตามนโยบาย' : monthly ? 'รายเดือน' : 'คิดตามชั่วโมง'}</td><td className="num">{profile ? monthly ? `${formatMoney(profile.monthlySalary)} / เดือน` : `${formatMoney(profile.hourlyRate)} / ชั่วโมง` : row.paySource === 'LEGACY_BASE_SALARY' ? `${formatMoney(row.legacyBaseSalary)} (ข้อมูลเดิม)` : '-'}</td><td>{profile ? formatDate(profile.effectiveFrom) : '-'}</td><td>{row.exempt ? <Badge variant="outline">ยกเว้น</Badge> : profile ? <Badge variant="success">พร้อมใช้งาน</Badge> : row.paySource === 'LEGACY_BASE_SALARY' ? <Badge variant="warning">รอกำหนดวันที่เริ่มใช้</Badge> : <Badge variant="warning">ยังไม่ได้กำหนด</Badge>}</td><td className="text-center">{canWrite && !row.exempt && <Button size="sm" variant="outline" onClick={() => open(row)}>กำหนดค่าจ้าง</Button>}</td></tr>;
        })}</tbody></table></div>
      )}
      <Dialog open={Boolean(selected)} onOpenChange={(value) => !value && setSelected(null)}><DialogContent title="กำหนดค่าจ้าง" description={selected ? `${selected.employeeCode} · ${selected.firstName} ${selected.lastName}` : undefined} className="max-w-md"><div className="space-y-4"><Field label="รูปแบบ"><Input value={selected && (selected.employmentType === 'MONTHLY' || selected.employmentType === 'CONTRACT') ? 'รายเดือน' : 'คิดตามชั่วโมง'} disabled /></Field><Field label={selected && (selected.employmentType === 'MONTHLY' || selected.employmentType === 'CONTRACT') ? 'เงินเดือน (บาท)' : 'อัตราค่าจ้าง (บาท / ชั่วโมง)'} required><Input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="กรอกอัตราจริง" /></Field><Field label="เริ่มใช้วันที่" required><Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field><p className="text-xs text-muted-foreground">ระบบไม่กำหนดจำนวนเงินหรือวันที่แทน กรุณาตรวจสอบข้อมูลจริงก่อนบันทึก</p><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setSelected(null)}>ยกเลิก</Button><Button disabled={!amount || Number(amount) <= 0 || !effectiveFrom} loading={mutation.isPending} onClick={() => mutation.mutate()}>บันทึก</Button></div></div></DialogContent></Dialog>
    </Card>
  );
}
