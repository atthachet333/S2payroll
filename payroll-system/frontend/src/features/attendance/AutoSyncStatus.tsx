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
    onSuccess: () => {
      toast.success('อัปเดตข้อมูลเรียบร้อยแล้ว');
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
  const failed =
    Boolean(status.lastErrorAt) &&
    (!status.lastSuccessfulAt || status.lastErrorAt! > status.lastSuccessfulAt);

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
      {status.enabled && !failed && !status.running && (
        <span className="text-muted-foreground/70">ทุก {status.intervalSeconds} วินาที</span>
      )}
      {canSync && (failed || !status.enabled) && (
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
