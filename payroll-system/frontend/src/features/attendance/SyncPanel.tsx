import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { sheetsApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  InfoRow,
} from '@/components/ui';
import { formatDateTime, formatNumber } from '@/utils/format';
import type { SyncResult } from '@/types';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'secondary' | 'outline';

/** How each preview classification is presented before the sync is applied. */
const PREVIEW_ACTION: Record<string, { label: string; tone: Tone }> = {
  NEW: { label: 'เพิ่มใหม่', tone: 'success' },
  UPDATE: { label: 'อัปเดต', tone: 'info' },
  DUPLICATE: { label: 'ซ้ำ / ไม่เปลี่ยน', tone: 'secondary' },
  PROTECTED: { label: 'ข้าม (แก้ไขด้วยมือ)', tone: 'warning' },
  LOCKED: { label: 'ข้าม (รอบถูกล็อก)', tone: 'outline' },
  INVALID: { label: 'ข้อมูลไม่ถูกต้อง', tone: 'danger' },
  UNKNOWN_EMPLOYEE: { label: 'ไม่พบพนักงาน', tone: 'danger' },
  MISSING_CHECKIN: { label: 'ไม่มีเวลาเข้า', tone: 'warning' },
  MISSING_CHECKOUT: { label: 'ไม่มีเวลาออก', tone: 'warning' },
  MULTIPLE_EVENTS: { label: 'หลายเหตุการณ์', tone: 'danger' },
  DUPLICATE_SOURCE_EVENT: { label: 'เหตุการณ์ต้นทางซ้ำ', tone: 'warning' },
  WORK_HOURS_MISMATCH: { label: 'ชั่วโมงไม่ตรง', tone: 'warning' },
};

const SYNC_STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'info' }> = {
  SUCCESS: { label: 'สำเร็จ', tone: 'success' },
  PARTIAL: { label: 'สำเร็จบางส่วน', tone: 'warning' },
  FAILED: { label: 'ล้มเหลว', tone: 'danger' },
  RUNNING: { label: 'กำลังทำงาน', tone: 'info' },
};

export default function SyncPanel({ canSync }: { canSync: boolean }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<SyncResult | null>(null);

  const statusQuery = useQuery({ queryKey: ['sheets-status'], queryFn: sheetsApi.status });
  const historyQuery = useQuery({
    queryKey: ['sheets-history'],
    queryFn: () => sheetsApi.history({ page: 1, pageSize: 10 }),
  });

  const syncMutation = useMutation({
    mutationFn: (dryRun: boolean) => sheetsApi.sync({ dryRun }),
    onSuccess: (result, dryRun) => {
      setLastResult(result);
      setConfirmOpen(false);
      if (dryRun) {
        toast.info(
          `ทดลองซิงค์: อ่าน ${result.totalRows} แถว, จะเพิ่ม ${result.imported}, จะอัปเดต ${result.updated}`
        );
        return;
      }
      if (result.status === 'SUCCESS') {
        toast.success(
          `ซิงค์สำเร็จ: เพิ่ม ${result.imported}, อัปเดต ${result.updated}, ซ้ำ ${result.duplicates}`
        );
      } else if (result.status === 'PARTIAL') {
        toast.warning(`ซิงค์สำเร็จบางส่วน: มีข้อผิดพลาด ${result.errors.length} แถว`);
      } else {
        toast.error('ซิงค์ล้มเหลว กรุณาตรวจสอบรายละเอียดข้อผิดพลาด');
      }
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['sheets-status'] });
      void queryClient.invalidateQueries({ queryKey: ['sheets-history'] });
    },
    onError: (err) => {
      setConfirmOpen(false);
      toast.error(apiErrorMessage(err));
    },
  });

  const status = statusQuery.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>เชื่อมต่อ Google Sheets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!status?.configured && (
            <div className="flex items-start gap-2.5 rounded-lg bg-warning-soft px-3.5 py-3 text-sm text-warning-fg">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">ยังไม่ได้ตั้งค่าการเชื่อมต่อ</p>
                <p className="mt-0.5">
                  กรุณากำหนด GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY และ GOOGLE_SHEET_ID
                  ในไฟล์ .env ของฝั่ง backend
                </p>
              </div>
            </div>
          )}

          <div className="flex items-start gap-2.5 rounded-lg bg-info-soft px-3.5 py-3 text-sm text-info-fg">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              ระบบเปิด Google Sheet แบบอ่านอย่างเดียว
              ข้อมูลต้นทางจะไม่ถูกแก้ไข และการแก้ไขด้วยมือในระบบจะไม่ถูกเขียนทับโดยการซิงค์
            </p>
          </div>

          <div className="divide-y divide-border/70">
            <InfoRow label="Sheet ID" value={status?.sheetId ?? '-'} />
            <InfoRow label="ช่วงข้อมูล" value={status?.range ?? '-'} />
            <InfoRow
              label="ซิงค์ล่าสุด"
              value={status?.lastSync ? formatDateTime(status.lastSync.startedAt) : 'ยังไม่เคยซิงค์'}
            />
            {status?.lastSync && (
              <>
                <InfoRow
                  label="ผลลัพธ์ล่าสุด"
                  value={
                    <Badge variant={SYNC_STATUS[status.lastSync.status]?.tone ?? 'secondary'}>
                      {SYNC_STATUS[status.lastSync.status]?.label ?? status.lastSync.status}
                    </Badge>
                  }
                />
                <InfoRow
                  label="จำนวนแถวที่อ่าน"
                  value={formatNumber(status.lastSync.totalRows)}
                />
              </>
            )}
          </div>

          {canSync && (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirmOpen(true)} loading={syncMutation.isPending}>
                <RefreshCw className="h-4 w-4" />
                ซิงค์ข้อมูลตอนนี้
              </Button>
              <Button
                variant="outline"
                onClick={() => syncMutation.mutate(true)}
                loading={syncMutation.isPending}
              >
                ทดลองซิงค์ (ไม่บันทึก)
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {lastResult && (
        <Card>
          <CardHeader>
            <CardTitle>ผลการซิงค์ล่าสุด</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <ResultTile label="อ่านทั้งหมด" value={lastResult.totalRows} />
              <ResultTile label="เพิ่มใหม่" value={lastResult.imported} tone="success" />
              <ResultTile label="อัปเดต" value={lastResult.updated} tone="info" />
              <ResultTile label="ซ้ำ/ไม่เปลี่ยน" value={lastResult.duplicates} />
              <ResultTile label="ป้องกันการเขียนทับ" value={lastResult.protected} tone="warning" />
              <ResultTile label="รอบถูกล็อก" value={lastResult.skipped} />
              <ResultTile label="ข้อมูลไม่ถูกต้อง" value={lastResult.invalid ?? 0} tone="danger" />
              <ResultTile
                label="ไม่พบพนักงาน"
                value={lastResult.unknownEmployee ?? 0}
                tone="danger"
              />
            </div>

            {((lastResult.invalid ?? 0) > 0 || (lastResult.unknownEmployee ?? 0) > 0) && (
              <div className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3.5 py-3 text-sm text-danger-fg">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  แถวที่ข้อมูลไม่ถูกต้องหรือไม่พบรหัสพนักงาน
                  <strong> จะไม่ถูกนำเข้า</strong> กรุณาแก้ไขข้อมูลในชีต
                  หรือเพิ่มพนักงานในระบบ แล้วซิงค์อีกครั้ง
                  ระบบจะไม่เดาว่าแถวนั้นเป็นของพนักงานคนใด
                </p>
              </div>
            )}

            {lastResult.dryRun && (
              <div className="rounded-lg bg-info-soft px-3.5 py-2.5 text-sm text-info-fg">
                นี่คือการทดลองซิงค์ ยังไม่มีการบันทึกข้อมูลใด ๆ ลงฐานข้อมูล
                กด &ldquo;ซิงค์ข้อมูลตอนนี้&rdquo; เพื่อนำเข้าจริง
              </div>
            )}

            {/* Row-level preview, shown before anything is written. */}
            {lastResult.preview && lastResult.preview.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="bg-secondary/60 px-3.5 py-2 text-sm font-medium">
                  ตัวอย่างรายการ ({lastResult.preview.length} วันพนักงาน, {lastResult.sourceEvents} เหตุการณ์ต้นทาง)
                </div>
                <div className="max-h-72 overflow-y-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>แถว</th>
                        <th>รหัสพนักงาน</th>
                        <th>ชื่อพนักงาน</th>
                        <th>วันที่</th>
                        <th>เข้า</th>
                        <th>ออก</th>
                        <th>การเปลี่ยนแปลง</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastResult.preview.map((r, i) => (
                        <tr key={`${r.row}-${i}`}>
                          <td className="text-muted-foreground">{r.row}</td>
                          <td className="font-medium">{r.employeeCode || '—'}</td>
                          <td className={r.employeeName ? undefined : 'text-danger'}>
                            {r.employeeName ?? 'ไม่พบในระบบ'}
                          </td>
                          <td>{r.date}</td>
                          <td className="tabular-nums">{r.checkIn ?? '—'}</td>
                          <td className="tabular-nums">{r.checkOut ?? '—'}</td>
                          <td>
                            <Badge variant={(PREVIEW_ACTION[r.action] ?? PREVIEW_ACTION.INVALID).tone}>
                              {(PREVIEW_ACTION[r.action] ?? PREVIEW_ACTION.INVALID).label}
                            </Badge>
                            {r.reason && (
                              <div className="mt-0.5 text-xs text-muted-foreground">{r.reason}</div>
                            )}
                            {(r.previousCheckIn || r.previousCheckOut) && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                เดิม {r.previousCheckIn ?? '—'} - {r.previousCheckOut ?? '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {lastResult.errors.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-danger/25">
                <div className="bg-danger-soft px-3.5 py-2 text-sm font-medium text-danger-fg">
                  รายการที่มีข้อผิดพลาด ({lastResult.errors.length})
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>แถว</th>
                        <th>รหัสพนักงาน</th>
                        <th>วันที่</th>
                        <th>ปัญหา</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastResult.errors.map((err, i) => (
                        <tr key={`${err.row}-${i}`}>
                          <td>{err.row}</td>
                          <td>{err.employeeCode || '-'}</td>
                          <td>{err.date || '-'}</td>
                          <td className="text-danger">{err.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>ประวัติการซิงค์</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {historyQuery.data && historyQuery.data.items.length === 0 ? (
            <EmptyState
              icon={<RefreshCw className="h-6 w-6" />}
              title="ยังไม่มีประวัติการซิงค์"
              description="เมื่อซิงค์ข้อมูลครั้งแรก ประวัติจะแสดงที่นี่"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>เวลา</th>
                    <th>สถานะ</th>
                    <th className="text-right">อ่าน</th>
                    <th className="text-right">เพิ่ม</th>
                    <th className="text-right">อัปเดต</th>
                    <th className="text-right">ซ้ำ</th>
                    <th className="text-right">ป้องกัน</th>
                    <th className="text-right">ผิดพลาด</th>
                    <th className="text-right">ใช้เวลา</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data?.items.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDateTime(item.startedAt)}</td>
                      <td>
                        <Badge variant={SYNC_STATUS[item.status]?.tone ?? 'secondary'}>
                          {SYNC_STATUS[item.status]?.label ?? item.status}
                        </Badge>
                      </td>
                      <td className="num">{formatNumber(item.totalRows)}</td>
                      <td className="num text-success">{formatNumber(item.importedCount)}</td>
                      <td className="num">{formatNumber(item.updatedCount)}</td>
                      <td className="num text-muted-foreground">{formatNumber(item.duplicateCount)}</td>
                      <td className="num text-warning">{formatNumber(item.protectedCount)}</td>
                      <td className="num text-danger">{formatNumber(item.errorCount)}</td>
                      <td className="num text-muted-foreground">
                        {item.durationMs ? `${(item.durationMs / 1000).toFixed(1)} วิ` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="ยืนยันการซิงค์ข้อมูล"
        description="ระบบจะดึงข้อมูลการลงเวลาจาก Google Sheets เข้าสู่ฐานข้อมูล ข้อมูลใน Google Sheet จะไม่ถูกแก้ไข และรายการที่แก้ไขด้วยมือจะถูกเก็บไว้ตามเดิม"
        confirmLabel="เริ่มซิงค์"
        loading={syncMutation.isPending}
        onConfirm={() => syncMutation.mutate(false)}
      />
    </div>
  );
}

function ResultTile({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'info' | 'warning' | 'danger';
}) {
  const toneClass = {
    default: 'text-foreground',
    success: 'text-success',
    info: 'text-info',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone];

  return (
    <div className="rounded-lg border border-border px-3 py-2.5 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${toneClass}`}>{formatNumber(value)}</p>
    </div>
  );
}
