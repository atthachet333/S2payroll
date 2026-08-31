import * as React from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Loader2, Lock, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthContext';
import AuthShell from '@/features/auth/AuthShell';
import {
  errorBoxClass,
  fieldWithToggleClass,
  iconClass,
  labelClass,
  primaryButtonClass,
  toggleButtonClass,
} from '@/features/auth/authStyles';
import { authApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';

/**
 * Guided password replacement for an account the server has flagged with
 * mustChangePassword (it answers PASSWORD_CHANGE_REQUIRED on every other
 * route). Reachable voluntarily too, so a signed-in user can rotate their own
 * password.
 *
 * Changing a password revokes every refresh token server-side, which would
 * leave the current session unable to refresh. Rather than silently stranding
 * the user, the new credentials are used to sign in again immediately, so the
 * session that continues into the app is a genuinely fresh one.
 */

/** Mirrors changePasswordSchema on the server. Kept as a hint, not a gate - */
/** the server remains the authority and its message is surfaced verbatim. */
const POLICY = 'อย่างน้อย 8 ตัวอักษร ประกอบด้วยตัวอักษรและตัวเลขอย่างน้อยอย่างละ 1 ตัว';

const meetsPolicy = (value: string) =>
  value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  describedBy?: string;
  invalid?: boolean;
  icon: React.ReactNode;
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  describedBy,
  invalid,
  icon,
}: FieldProps) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
        <span className="ml-0.5 text-[#c0392b]" aria-hidden>
          *
        </span>
      </label>
      <div className="relative">
        {icon}
        <input
          id={id}
          name={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={fieldWithToggleClass}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
          aria-pressed={visible}
          className={toggleButtonClass}
        >
          {visible ? <EyeOff className="h-[18px] w-[18px]" /> : <Eye className="h-[18px] w-[18px]" />}
        </button>
      </div>
    </div>
  );
}

export default function ChangePasswordPage() {
  const { user, loading, login, logout } = useAuth();
  const navigate = useNavigate();

  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;

  const forced = user.mustChangePassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (next !== confirm) {
      setError('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
      return;
    }
    if (!meetsPolicy(next)) {
      setError(`รหัสผ่านใหม่ไม่ตรงตามเงื่อนไข: ${POLICY}`);
      return;
    }
    if (next === current) {
      setError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน');
      return;
    }

    setSubmitting(true);
    try {
      await authApi.changePassword(current, next);
      // The change revoked every refresh token, so re-establish a clean
      // session with the new credentials before continuing into the app.
      await login(user.email, next);
      toast.success('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว');
      navigate('/', { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[#0E4C4F]">
        เปลี่ยนรหัสผ่าน
      </h1>
      <p className="mt-1 text-lg font-medium text-[#17696D]">ระบบบริหารเงินเดือน</p>
      <p className="text-sm tracking-wide text-slate-500">Payroll Management System</p>

      {forced ? (
        <div className="mt-5 flex gap-3 rounded-xl border border-[#cfe0e1] bg-[#f2f8f8] px-4 py-3.5">
          <ShieldAlert aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-[#17696D]" />
          <p className="text-sm leading-relaxed text-slate-700">
            บัญชีนี้ยังใช้รหัสผ่านเริ่มต้น กรุณาตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งานระบบ
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-slate-600">
          ตั้งรหัสผ่านใหม่สำหรับบัญชี {user.email}
        </p>
      )}

      <div aria-hidden className="my-7 h-px bg-gradient-to-r from-[#cfe0e1] to-transparent" />

      <form onSubmit={submit} noValidate className="space-y-5">
        <PasswordField
          id="currentPassword"
          label="รหัสผ่านปัจจุบัน"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          describedBy={error ? 'change-password-error' : undefined}
          invalid={Boolean(error)}
          icon={<Lock aria-hidden className={iconClass} />}
        />

        <div className="space-y-1.5">
          <PasswordField
            id="newPassword"
            label="รหัสผ่านใหม่"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            describedBy="password-policy"
            invalid={Boolean(error)}
            icon={<KeyRound aria-hidden className={iconClass} />}
          />
          <p id="password-policy" className="text-xs leading-relaxed text-slate-500">
            {POLICY}
          </p>
        </div>

        <PasswordField
          id="confirmPassword"
          label="ยืนยันรหัสผ่านใหม่"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          describedBy={error ? 'change-password-error' : undefined}
          invalid={Boolean(error)}
          icon={<KeyRound aria-hidden className={iconClass} />}
        />

        <div aria-live="polite" aria-atomic="true">
          {error && (
            <p id="change-password-error" role="alert" className={errorBoxClass}>
              {error}
            </p>
          )}
        </div>

        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
          {submitting ? 'กำลังบันทึก...' : 'บันทึกรหัสผ่านใหม่'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => void logout()}
        className="mt-6 w-full text-center text-sm text-slate-500 underline-offset-4 transition-colors hover:text-[#17696D] hover:underline focus:outline-none focus:ring-2 focus:ring-[#17696D]/30 focus:ring-offset-2"
      >
        ออกจากระบบ
      </button>
    </AuthShell>
  );
}
