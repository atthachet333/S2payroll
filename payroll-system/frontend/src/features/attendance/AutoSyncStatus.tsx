import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { POLL_INTERVAL_MS, sheetsApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { Button } from '@/components/ui';

/**
 * Compact indicator for the background Google sync.
 *
 * Shows only operational facts. The backend already scrubs credentials and
 * connection strings out of any error text, and this deliberately renders a
 * short plain-language line rather than the raw message, so an ordinary user
 * never meets a stack trace.
 */
export default function AutoSyncStatus({ canSync = false }: { canSync?: boolean }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['auto-sync-status'],
    queryFn: sheetsApi.autoSyncStatus,
    refetchInterval: POLL_INTERVAL_MS.autoSyncStatus,
    refetchOnWindowFocus: true,
  });

  const retry = useMutation({
    mutationFn: sheetsApi.syncAll,
    onSuccess: (result) => {
      if (result.overall === 'PARTIAL') toast.warning('อัปเดตบางส่วน กรุณาตรวจสอบรายละเอียด');
      else if (result.overall === 'FAILED') toast.error('อัปเดตไม่สำเร็จ');
      else toast.success('อัปเดตข้อมูลเรียบร้อยแล้ว');
      void queryClient.invalidateQueries({ queryKey: ['auto-sync-status'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance'] });
      void queryClient.invalidateQueries({ queryKey: ['attendance-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['work-calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });

  const status = query.data;
  if (!status) return null;

  const clock = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString('th-TH', { hour12: false }) : '-';

  // The most recent cycle failed if an error landed after the last success.
  const failed = status.overall === 'FAILED';
  const partial = status.overall === 'PARTIAL';

  let dot = 'bg-success';
  let text = `อัปเดตอัตโนมัติ · ล่าสุด ${clock(status.lastSuccessfulAt)}`;

  if (!status.enabled) {
    dot = 'bg-muted-foreground';
    text = 'อัปเดตอัตโนมัติปิดอยู่';
  } else if (status.running || retry.isPending) {
    dot = 'bg-info animate-pulse';
    text = 'กำลังอัปเดต...';
  } else if (failed) {
    dot = 'bg-danger';
    text = 'อัปเดตไม่สำเร็จ';
  } else if (partial) {
    dot = 'bg-warning';
    text = 'อัปเดตบางส่วน';
  } else if (!status.lastSuccessfulAt) {
    dot = 'bg-muted-foreground';
    text = `อัปเดตอัตโนมัติ · รอบถัดไปภายใน ${status.intervalSeconds} วินาที`;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span>{text}</span>
      {(partial || failed) && (
        <details className="relative">
          <summary className="cursor-pointer text-primary">รายละเอียด</summary>
          <div className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-border bg-white p-3 shadow-pop">
            {([
              ['employees', 'พนักงาน'],
              ['attendance', 'การลงเวลา'],
              ['leave', 'ข้อมูลการลา'],
            ] as const).map(([key, label]) => {
              const source = status.sources[key];
              return (
                <div key={key} className="border-b border-border py-1.5 last:border-0">
                  <div className="flex justify-between gap-4">
                    <span>{label}</span>
                    <span className={source.status === 'FAILED' ? 'text-danger' : source.status === 'SUCCESS' ? 'text-success' : ''}>
                      {source.status === 'FAILED' ? 'ไม่สำเร็จ' : source.status === 'SUCCESS' ? 'สำเร็จ' : source.status}
                    </span>
                  </div>
                  {source.status === 'FAILED' && source.lastErrorSummary && (
                    <p className="mt-1 break-words text-[11px] text-danger">{source.lastErrorSummary}</p>
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {status.enabled && !failed && !status.running && (
        <span className="text-muted-foreground/70">ทุก {status.intervalSeconds} วินาที</span>
      )}
      {canSync && (failed || partial || !status.enabled) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          loading={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RefreshCw className="h-3 w-3" />
          ลองใหม่
        </Button>
      )}
    </div>
  );
}
