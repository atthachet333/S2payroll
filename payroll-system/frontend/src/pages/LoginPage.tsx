import * as React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import AuthShell from '@/features/auth/AuthShell';
import {
  errorBoxClass,
  fieldClass,
  fieldWithToggleClass,
  iconClass,
  labelClass,
  primaryButtonClass,
  toggleButtonClass,
} from '@/features/auth/authStyles';
import { apiErrorMessage } from '@/services/api';

/**
 * Sign-in screen. Layout and chrome live in AuthShell; this file owns only the
 * form and the authentication call.
 *
 * The auth flow is unchanged: same useAuth().login, same redirect to the
 * originally requested route, same apiErrorMessage handling. An account with
 * mustChangePassword set lands on '/' and is bounced to /change-password by
 * ProtectedRoute, mirroring the server's own enforcement.
 */
export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Do not permit a credential login while restoration of an older browser
  // session is still in flight. Otherwise the old refresh failure can race
  // the successful login and clear its newly issued tokens.
  if (loading) {
    return (
      <AuthShell>
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-slate-500">
          <Loader2 aria-hidden className="h-6 w-6 animate-spin text-[#17696D]" />
          <p className="text-sm">กำลังตรวจสอบเซสชัน...</p>
        </div>
      </AuthShell>
    );
  }

  if (user) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const sessionUser = await login(email, password);
      navigate(sessionUser.mustChangePassword ? '/change-password' : '/', { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[#0E4C4F]">
        เข้าสู่ระบบ
      </h1>
      <p className="mt-1 text-lg font-medium text-[#17696D]">ระบบบริหารเงินเดือน</p>
      <p className="text-sm tracking-wide text-slate-500">Payroll Management System</p>

      <p className="mt-4 text-sm leading-relaxed text-slate-600">
        เข้าสู่ระบบเพื่อจัดการข้อมูลพนักงาน เวลาเข้างาน และการคำนวณเงินเดือน
      </p>

      <div aria-hidden className="my-7 h-px bg-gradient-to-r from-[#cfe0e1] to-transparent" />

      <form onSubmit={submit} noValidate className="space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="email" className={labelClass}>
            อีเมล
            <span className="ml-0.5 text-[#c0392b]" aria-hidden>
              *
            </span>
          </label>
          <div className="relative">
            <Mail aria-hidden className={iconClass} />
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="กรอกอีเมลของคุณ"
              autoComplete="username"
              autoFocus
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className={fieldClass}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className={labelClass}>
            รหัสผ่าน
            <span className="ml-0.5 text-[#c0392b]" aria-hidden>
              *
            </span>
          </label>
          <div className="relative">
            <Lock aria-hidden className={iconClass} />
            <input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="กรอกรหัสผ่านของคุณ"
              autoComplete="current-password"
              required
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className={fieldWithToggleClass}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
              aria-pressed={showPassword}
              className={toggleButtonClass}
            >
              {showPassword ? (
                <EyeOff className="h-[18px] w-[18px]" />
              ) : (
                <Eye className="h-[18px] w-[18px]" />
              )}
            </button>
          </div>
        </div>

        {/* Announced to assistive tech the moment it appears. */}
        <div aria-live="polite" aria-atomic="true">
          {error && (
            <p id="login-error" role="alert" className={errorBoxClass}>
              {error}
            </p>
          )}
        </div>

        <button type="submit" disabled={submitting} className={primaryButtonClass}>
          {submitting && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
          {submitting ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        หากลืมรหัสผ่าน กรุณาติดต่อผู้ดูแลระบบ
      </p>
    </AuthShell>
  );
}
