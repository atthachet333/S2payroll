import * as React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { Button, Card, Field, Input } from '@/components/ui';
import { apiErrorMessage } from '@/services/api';

export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  if (!loading && user) {
    const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground">
            <Wallet className="h-7 w-7" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">ระบบบริหารเงินเดือน</h1>
            <p className="text-sm text-muted-foreground">Payroll Management System</p>
          </div>
        </div>

        <Card className="p-6">
          <form onSubmit={submit} className="space-y-4">
            <Field label="อีเมล" htmlFor="email" required>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.co.th"
                autoComplete="username"
                autoFocus
                required
              />
            </Field>

            <Field label="รหัสผ่าน" htmlFor="password" required error={error}>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>

            <Button type="submit" className="w-full" loading={submitting}>
              เข้าสู่ระบบ
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          หากลืมรหัสผ่าน กรุณาติดต่อผู้ดูแลระบบ
        </p>
      </div>
    </div>
  );
}
