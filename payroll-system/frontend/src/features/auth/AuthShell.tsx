import * as React from 'react';

/**
 * The shared S2A-PAYROLL entry-screen shell: a diagonal split with the payroll
 * artwork on the left and a form column on the right, joined by a circular
 * badge floating on the boundary.
 *
 * The split is driven by two custom properties so every layer - artwork,
 * badge, form column - stays in sync from one place:
 *
 *   --split  horizontal position of the diagonal at the TOP edge
 *   --skew   how far left the diagonal has travelled by the BOTTOM edge
 *
 * At mid-height the boundary therefore sits at `--split - --skew/2`, which is
 * where the badge is centred and where the form column starts clearing.
 *
 * Below md the diagonal is dropped entirely: artwork banner, badge, form.
 */

const ART = '/images/payroll-login-art.png';
const MARK = '/images/s2a-payroll-mark.png';

/** Faint teal geometry behind the form column. Decorative only. */
function Decor() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[#17696D]/[0.05] blur-2xl" />
      <div className="absolute -bottom-28 right-10 h-72 w-72 rounded-full bg-[#3fa9b0]/[0.06] blur-2xl" />
      <svg
        className="absolute -right-16 top-1/2 h-[560px] w-[560px] -translate-y-1/2 text-[#17696D]/[0.07]"
        viewBox="0 0 200 200"
        fill="none"
      >
        <circle cx="100" cy="100" r="99" stroke="currentColor" strokeWidth="0.5" />
        <circle cx="100" cy="100" r="72" stroke="currentColor" strokeWidth="0.5" />
        <circle cx="100" cy="100" r="45" stroke="currentColor" strokeWidth="0.5" />
      </svg>
    </div>
  );
}

export default function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative flex min-h-screen flex-col overflow-hidden bg-gradient-to-br from-white via-[#f7fafa] to-[#eaf1f2] [--skew:0px] [--split:0px] md:block md:[--skew:70px] md:[--split:50%] min-[1200px]:[--skew:150px] min-[1200px]:[--split:61%]"
    >
      <Decor />

      {/* ---------------------------------------------------------------- */}
      {/* Artwork. Diagonal panel from md up; plain banner on phones.       */}
      {/* ---------------------------------------------------------------- */}

      {/* The accent layer sits 5px wider than the artwork and carries the same
          clip, so only a hairline of it shows along the diagonal. `filter`
          applies after `clip-path`, so the drop shadow traces the diagonal
          itself and gives the artwork panel a real edge. */}
      <div
        aria-hidden
        className="absolute inset-y-0 left-0 hidden bg-gradient-to-b from-[#8fbabd] via-[#0E4C4F] to-[#a8c3c4] md:block"
        style={{
          width: 'calc(var(--split) + 5px)',
          clipPath: 'polygon(0 0, 100% 0, calc(100% - var(--skew)) 100%, 0 100%)',
          filter: 'drop-shadow(10px 0 26px rgba(14, 76, 79, 0.20))',
        }}
      />
      {/* The artwork is scaled to the panel's WIDTH at its natural aspect and
          pinned to the top, never stretched and never cropped: `cover` would
          fill a tall panel by eating the right-hand side of the image, which
          is exactly where ระบบบริหารเงินเดือน and Payroll Management System
          end. On a 16:9 screen the artwork happens to fill the panel almost
          exactly; on taller viewports the panel's pearl gradient - matched to
          the artwork's own bottom edge - carries on beneath it. */}
      <div
        className="absolute inset-y-0 left-0 hidden overflow-hidden bg-gradient-to-b from-[#dee6e8] via-[#e7edee] to-[#f2f6f6] md:block"
        style={{
          width: 'var(--split)',
          clipPath: 'polygon(0 0, 100% 0, calc(100% - var(--skew)) 100%, 0 100%)',
        }}
      >
        <img
          src={ART}
          alt="S2A-PAYROLL ระบบบริหารเงินเดือน — Payroll Management System"
          className="block w-full"
        />
      </div>

      {/* Phone banner: the same artwork, cropped to the branding band, with a
          gentle diagonal foot so the concept survives the stacked layout. */}
      <div
        className="relative h-52 w-full shrink-0 overflow-hidden bg-[#eef3f4] sm:h-60 md:hidden"
        style={{ clipPath: 'polygon(0 0, 100% 0, 100% calc(100% - 28px), 0 100%)' }}
      >
        <img
          src={ART}
          alt="S2A-PAYROLL ระบบบริหารเงินเดือน"
          className="h-full w-full object-cover"
          style={{ objectPosition: 'center 20%' }}
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Circular badge on the diagonal.                                   */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="relative z-20 -mt-11 grid h-[88px] w-[88px] shrink-0 place-items-center self-center rounded-full border-2 border-white bg-gradient-to-b from-white to-[#eef5f5] p-2 shadow-[0_0_0_1px_#b9d1d2,0_0_0_9px_rgba(255,255,255,0.7),0_18px_44px_-12px_rgba(14,76,79,0.5)] sm:h-[100px] sm:w-[100px] md:absolute md:top-1/2 md:mt-0 md:h-[112px] md:w-[112px] md:-translate-x-1/2 md:-translate-y-1/2 md:p-2.5 min-[1200px]:h-[140px] min-[1200px]:w-[140px] min-[1200px]:p-3"
        style={{ left: 'calc(var(--split) - var(--skew) / 2)' }}
      >
        <img
          src={MARK}
          alt="S2A-PAYROLL"
          className="h-full w-full rounded-full object-contain"
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Form column.                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="relative z-10 flex flex-1 flex-col md:absolute md:inset-y-0 md:right-0"
        style={{ left: 'var(--split)' }}
      >
        {/* pl clears the badge, which reaches ~half its radius past the split. */}
        <main className="flex flex-1 items-center justify-center px-6 py-10 sm:px-8 md:py-14 md:pl-14 md:pr-8 min-[1200px]:pl-16 min-[1200px]:pr-14">
          <div className="w-full max-w-[440px]">{children}</div>
        </main>

        <footer className="px-6 pb-7 text-center text-xs leading-relaxed text-slate-400 md:px-10">
          <p>© S2 ACCOUNTING CONSULTANT</p>
          <p>Payroll Management System</p>
        </footer>
      </div>
    </div>
  );
}
