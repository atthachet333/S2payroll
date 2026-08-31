/** Field and button styling shared by the login and change-password screens. */

export const fieldClass =
  'h-[52px] w-full rounded-xl border border-[#dbe5e6] bg-white/90 pl-11 pr-4 text-[15px] text-slate-900 placeholder:text-slate-400 transition-colors focus:border-[#17696D] focus:outline-none focus:ring-2 focus:ring-[#17696D]/25 disabled:bg-slate-50';

/** Same field, with room on the right for a visibility toggle. */
export const fieldWithToggleClass = `${fieldClass} pr-12`;

export const labelClass = 'block text-sm font-medium text-slate-700';

export const primaryButtonClass =
  'flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#0E4C4F] to-[#1B7276] text-[15px] font-semibold text-white shadow-sm transition-[filter,opacity] hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#17696D]/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70';

export const toggleButtonClass =
  'absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition-colors hover:text-[#17696D] focus:outline-none focus:ring-2 focus:ring-[#17696D]/30';

export const errorBoxClass =
  'rounded-lg border border-[#f0c9c4] bg-[#fdf3f2] px-3.5 py-2.5 text-sm text-[#a13527]';

export const iconClass =
  'pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400';
