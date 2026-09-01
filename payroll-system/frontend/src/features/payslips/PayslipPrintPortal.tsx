import { createPortal } from 'react-dom';
import { PayslipSheet } from '@/features/payslips/PayslipDocument';
import type { PayslipSnapshot } from '@/types';

/**
 * The copy of the payslip that actually gets printed.
 *
 * Why a portal rather than printing the dialog: the preview lives inside a
 * Radix dialog panel that is `position: fixed`, centred with
 * `translate(-50%, -50%)`, and clipped by `max-height: 92vh; overflow-y: auto`.
 * A transform makes that panel a containing block, so the old print rule -
 * `.print-area { position: absolute; inset: 0 }` - resolved against the dialog
 * instead of the page. On paper that pushed the payslip halfway down, the
 * scroll clipping cut it, and the application DOM still behind the modal kept
 * paginating: four pages, most of the first one blank.
 *
 * Mounting a second copy directly on document.body removes the cause rather
 * than fighting it. This element has no fixed, transformed or scrolling
 * ancestor, so print layout starts at the top of the page. It is display:none
 * on screen and only becomes visible inside @media print, where every other
 * child of body is hidden.
 *
 * Both copies render the same PayslipSheet from the same snapshot, so the
 * preview and the printout cannot drift apart.
 */
export default function PayslipPrintPortal({ snapshot }: { snapshot: PayslipSnapshot | null }) {
  if (!snapshot || typeof document === 'undefined') return null;

  return createPortal(
    <div id="payslip-print-root" aria-hidden>
      <PayslipSheet snapshot={snapshot} />
    </div>,
    document.body
  );
}
