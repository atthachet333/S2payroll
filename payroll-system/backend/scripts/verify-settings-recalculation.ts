/** Guarded, self-reverting live proof that persisted settings drive recalculation. */
import 'dotenv/config';
import { prisma } from '../src/plugins/prisma.js';
import { checkDatabaseUrl } from './db-guard.js';
import { recalculateRange } from '../src/services/attendance.service.js';

const guard = checkDatabaseUrl(process.env.DATABASE_URL);
if (!guard.ok) throw new Error(guard.message);

async function main() {
  const [{ db }] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT DATABASE() AS db');
  if (db !== 's2apayroll') throw new Error(`Refusing database ${db}`);
  const setting = await prisma.payrollSetting.findUniqueOrThrow({ where: { key: 'BREAK_MINUTES' } });
  const record = await prisma.attendanceRecord.findFirstOrThrow({
    where: { isLocked: false, isCorrected: false, checkIn: { not: null }, checkOut: { not: null }, workedMinutes: { gt: 0 } },
    orderBy: { workDate: 'asc' },
  });
  const alternate = setting.value === '30' ? '45' : '30';
  console.log(`SELECT DATABASE() => ${db}`);
  console.log(`target=${record.employeeCode}/${record.workDate.toISOString().slice(0, 10)} originalBreak=${setting.value} originalWorked=${record.workedMinutes}`);
  try {
    await prisma.payrollSetting.update({ where: { key: setting.key }, data: { value: alternate } });
    const readback = await prisma.payrollSetting.findUniqueOrThrow({ where: { key: setting.key } });
    const changed = await recalculateRange(record.workDate, record.workDate, record.employeeId);
    const after = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    console.log(`readbackBreak=${readback.value} updated=${changed.updated} workedAfter=${after.workedMinutes}`);
    if (readback.value !== alternate || after.workedMinutes === record.workedMinutes) {
      throw new Error('Setting did not affect recalculation');
    }
  } finally {
    await prisma.payrollSetting.update({ where: { key: setting.key }, data: { value: setting.value } });
    await recalculateRange(record.workDate, record.workDate, record.employeeId);
    const restored = await prisma.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
    console.log(`restoredBreak=${setting.value} restoredWorked=${restored.workedMinutes}`);
    if (restored.workedMinutes !== record.workedMinutes) throw new Error('Attendance restoration mismatch');
  }
}

main().finally(() => prisma.$disconnect());
