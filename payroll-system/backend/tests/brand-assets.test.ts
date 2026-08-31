import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

/**
 * Asset and wiring checks for the S2A-PAYROLL shell.
 *
 * These guard two things that are easy to regress silently: the favicon
 * quietly reverting to an opaque square, and demo employee data creeping back
 * into the frontend after the real roster was imported.
 */

const FRONTEND = path.resolve(__dirname, '../../frontend');
const read = (p: string) => fs.readFileSync(path.join(FRONTEND, p));
const exists = (p: string) => fs.existsSync(path.join(FRONTEND, p));

describe('favicon is a true circle', () => {
  it('ships favicon.png and favicon.ico', () => {
    expect(exists('public/favicon.png')).toBe(true);
    expect(exists('public/favicon.ico')).toBe(true);
  });

  it('is square and at least 128px so it stays legible when scaled down', () => {
    const png = PNG.sync.read(read('public/favicon.png'));
    expect(png.width).toBe(png.height);
    expect(png.width).toBeGreaterThanOrEqual(128);
  });

  it('has fully transparent corners - not a rounded rectangle', () => {
    const png = PNG.sync.read(read('public/favicon.png'));
    const alpha = (x: number, y: number) => png.data[((png.width * y + x) << 2) + 3];
    const max = png.width - 1;
    for (const [x, y] of [[0, 0], [max, 0], [0, max], [max, max]] as const) {
      expect(alpha(x, y), `corner ${x},${y}`).toBe(0);
    }
  });

  it('is opaque at the centre, so the mark itself survived the mask', () => {
    const png = PNG.sync.read(read('public/favicon.png'));
    const mid = Math.floor(png.width / 2);
    expect(png.data[((png.width * mid + mid) << 2) + 3]).toBe(255);
  });

  it('is transparent outside the inscribed circle but opaque just inside it', () => {
    const png = PNG.sync.read(read('public/favicon.png'));
    const alpha = (x: number, y: number) => png.data[((png.width * y + x) << 2) + 3];
    const c = png.width / 2;
    const r = c - 1;
    // A point on the diagonal well outside the disc but inside the bitmap.
    const out = Math.round(c - (r * 0.78));
    expect(alpha(out, out)).toBe(0);
    // A point just inside the disc along the same diagonal.
    const inn = Math.round(c - (r * 0.6));
    expect(alpha(inn, inn)).toBe(255);
  });

  it('keeps teal in the mark rather than flattening it to greyscale', () => {
    const png = PNG.sync.read(read('public/favicon.png'));
    let teal = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3] < 128) continue;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      // Teal: blue and green clearly ahead of red.
      if (g > r + 18 && b > r + 18) teal += 1;
    }
    expect(teal).toBeGreaterThan(500);
  });
});

describe('application shell branding', () => {
  const html = read('index.html').toString('utf8');

  it('titles the app S2A-PAYROLL', () => {
    expect(html).toContain('<title>S2A-PAYROLL</title>');
    expect(html).not.toContain('<title>ระบบบริหารเงินเดือน</title>');
  });

  it('links both favicon forms', () => {
    expect(html).toMatch(/rel="icon"[^>]*href="\/favicon\.png"/);
    expect(html).toMatch(/rel="shortcut icon"[^>]*href="\/favicon\.ico"/);
  });
});

describe('frontend carries no demo employee data', () => {
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(path.join(FRONTEND, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(rel);
      return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
    });

  it('mentions no seeded EMPnnn employee codes', () => {
    const offenders = sourceFiles('src').filter((f) =>
      /\bEMP\d{3}\b/.test(read(f).toString('utf8'))
    );
    expect(offenders).toEqual([]);
  });

  it('mentions none of the seeded demo employee names', () => {
    const demoNames = ['สมชาย ใจดี', 'สมหญิง รักงาน', 'ประเสริฐ มั่นคง', 'วิภา สดใส', 'อนันต์ ตั้งใจ', 'กมล ชูใจ'];
    const offenders = sourceFiles('src').filter((f) => {
      const text = read(f).toString('utf8');
      return demoNames.some((n) => text.includes(n));
    });
    expect(offenders).toEqual([]);
  });

  it('loads the employee list from the API rather than a literal array', () => {
    const page = read('src/pages/EmployeesPage.tsx').toString('utf8');
    expect(page).toContain('employeeApi.list');
    // A hardcoded roster would show up as an array of objects carrying codes.
    expect(page).not.toMatch(/employeeCode\s*:\s*['"]/);
  });

  it('offers search, department, employment-type and status filters', () => {
    const page = read('src/pages/EmployeesPage.tsx').toString('utf8');
    expect(page).toContain('setSearch');
    expect(page).toContain('setDepartmentId');
    expect(page).toContain('setEmploymentType');
    expect(page).toContain('setStatus');
  });
});
