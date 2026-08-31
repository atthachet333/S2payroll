/**
 * Read-only look at what checkout summaries the archived raw events actually
 * contain, so the calendar work is built on real shapes rather than guesses.
 *
 * Usage: tsx scripts/inspect-checkout-summaries.ts
 */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';

async function main(): Promise<void> {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  console.log(`SELECT DATABASE() => ${db}  (read only)\n`);

  const raw = await prisma.attendanceRawData.findMany({
    select: { employeeCode: true, rawDate: true, rawCheckOut: true, payload: true, rowHash: true },
    orderBy: [{ rawDate: 'asc' }, { employeeCode: 'asc' }],
  });
  console.log(`attendance_raw_data rows: ${raw.length}`);

  const withSummary = raw.filter((r) => {
    const p = r.payload as Record<string, unknown> | null;
    return p && typeof p.summary === 'string' && p.summary.trim() !== '';
  });
  console.log(`rows carrying a non-empty summary: ${withSummary.length}\n`);

  const byType: Record<string, number> = {};
  for (const r of raw) {
    const p = r.payload as Record<string, unknown> | null;
    const t = String(p?.type ?? '(none)').toLowerCase();
    byType[t] = (byType[t] ?? 0) + 1;
  }
  console.log(`event types archived: ${JSON.stringify(byType)}`);

  const checkoutSummaries = withSummary.filter((r) => {
    const p = r.payload as Record<string, unknown>;
    return String(p.type ?? '').toLowerCase().includes('out');
  });
  console.log(`checkout events with a summary: ${checkoutSummaries.length}`);

  const dates = [...new Set(checkoutSummaries.map((r) => r.rawDate))].sort();
  console.log(`dates having checkout summaries: ${dates.join(', ') || '(none)'}\n`);

  console.log('SHAPE SAMPLE (text truncated - content is employee-authored):');
  for (const r of checkoutSummaries.slice(0, 6)) {
    const p = r.payload as Record<string, unknown>;
    const text = String(p.summary ?? '');
    console.log(
      `  ${r.employeeCode}  ${r.rawDate}  out=${String(p.time ?? '-')}  ` +
      `len=${text.length}  newlines=${(text.match(/\n/g) ?? []).length}  ` +
      `clientRequestId=${String(p.clientRequestId ?? '').slice(0, 8)}...`
    );
  }

  // Does any employee have more than one checkout summary on one date?
  const perDay = new Map<string, number>();
  for (const r of checkoutSummaries) {
    const key = `${r.employeeCode}|${r.rawDate}`;
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const multi = [...perDay.entries()].filter(([, n]) => n > 1);
  console.log(`\nemployee-days with multiple checkout summaries: ${multi.length}`);
  for (const [key, n] of multi) console.log(`  ${key} -> ${n}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
