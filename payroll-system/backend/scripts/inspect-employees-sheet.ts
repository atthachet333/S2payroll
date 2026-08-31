/**
 * Read-only inspection of the `Employees` tab in the S2A_DB spreadsheet.
 *
 * Uses the spreadsheets.readonly scope and only calls values.get, so the sheet
 * cannot be modified. Reports the real headers rather than assuming any
 * structure; masks anything that looks like a national ID, bank account or
 * LINE user id so the inventory does not spill personal identifiers into logs.
 *
 * Usage: tsx scripts/inspect-employees-sheet.ts [tabName]
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { env, googlePrivateKey, isGoogleSheetsConfigured } from '../src/config/env.js';
import { buildSheetRange } from '../src/config/env.js';

const TAB = process.argv[2] || 'Employees';

/** Header names whose values must never be printed in full. */
const SENSITIVE = /national|citizen|idcard|บัตรประชาชน|bank|account|ธนาคาร|บัญชี|salary|เงินเดือน|userid|user_id|lineid|line_id|tax|phone|โทร|email/i;

const mask = (value: string): string => {
  if (!value) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(6, value.length - 4))}${value.slice(-2)}`;
};

async function main(): Promise<void> {
  if (!isGoogleSheetsConfigured()) {
    console.error('Google Sheets is not configured (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID).');
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: env.GOOGLE_CLIENT_EMAIL,
    key: googlePrivateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // List the tabs so the report names what actually exists.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SHEET_ID });
  console.log(`\nSpreadsheet: ${meta.data.properties?.title}`);
  console.log('Tabs: ' + (meta.data.sheets ?? []).map((s) => s.properties?.title).join(', '));

  const range = buildSheetRange(TAB);
  console.log(`\nReading ${range} (values.get, read-only scope)`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range,
  });
  const values = (res.data.values ?? []) as string[][];
  if (!values.length) {
    console.log('Tab is empty.');
    return;
  }

  const headers = values[0].map((h) => String(h ?? '').trim());
  const rows = values.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));

  console.log(`\nHEADERS (${headers.length}):`);
  headers.forEach((h, i) => console.log(`  [${String(i).padStart(2)}] ${h}${SENSITIVE.test(h) ? '   (sensitive - masked below)' : ''}`));
  console.log(`\nDATA ROWS: ${rows.length}`);

  const cell = (row: string[], i: number) => String(row[i] ?? '').trim();

  console.log('\nSAMPLE (first 8 rows, sensitive columns masked):');
  for (const row of rows.slice(0, 8)) {
    const parts = headers.map((h, i) => `${h}=${SENSITIVE.test(h) ? mask(cell(row, i)) : cell(row, i)}`);
    console.log('  ' + parts.filter((p) => !p.endsWith('=')).join(' | '));
  }

  // Per-column fill rate and distinct values, to show what is actually usable.
  console.log('\nCOLUMN FILL RATE / DISTINCT:');
  headers.forEach((h, i) => {
    const filled = rows.filter((r) => cell(r, i) !== '').length;
    const distinct = new Set(rows.map((r) => cell(r, i)).filter(Boolean));
    const preview = SENSITIVE.test(h)
      ? '(masked)'
      : [...distinct].slice(0, 6).join(', ') + (distinct.size > 6 ? ', ...' : '');
    console.log(`  ${h.padEnd(20)} filled=${String(filled).padStart(3)}/${rows.length}  distinct=${String(distinct.size).padStart(3)}  ${preview}`);
  });

  // Anything that looks like the employee code column.
  const codeIdx = headers.findIndex((h) => /^(empid|employee_?code|employeeid|รหัสพนักงาน|code)$/i.test(h.replace(/[\s_]/g, '')));
  if (codeIdx >= 0) {
    const codes = rows.map((r) => cell(r, codeIdx)).filter(Boolean);
    const unique = [...new Set(codes)].sort();
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    console.log(`\nEMPLOYEE CODES (column "${headers[codeIdx]}"):`);
    console.log(`  unique (${unique.length}): ${unique.join(', ')}`);
    console.log(`  blank: ${rows.length - codes.length}`);
    console.log(`  duplicates: ${dupes.length ? [...new Set(dupes)].join(', ') : 'none'}`);
  } else {
    console.log('\nNo obvious employee-code column matched; see headers above.');
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
