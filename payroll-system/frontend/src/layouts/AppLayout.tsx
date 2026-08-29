import * as React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Banknote,
  CalendarClock,
  ChevronDown,
  FileText,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings as SettingsIcon,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/features/auth/AuthContext';
import { Button, Dialog, DialogContent, Field, Input } from '@/components/ui';
import { authApi } from '@/services/endpoints';
import { apiErrorMessage } from '@/services/api';
import { cn } from '@/utils/cn';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  permission: string;
}

/**
 * Top navigation, as specified: no large permanent left sidebar, so each page
 * gets the full width for its content.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'ภาพรวม', icon: <LayoutDashboard className="h-4 w-4" />, permission: 'payroll:read' },
  { to: '/employees', label: 'พนักงาน', icon: <Users className="h-4 w-4" />, permission: 'employee:read' },
  { to: '/attendance', label: 'การลงเวลา', icon: <CalendarClock className="h-4 w-4" />, permission: 'attendance:read' },
  { to: '/payroll', label: 'เงินเดือน', icon: <Wallet className="h-4 w-4" />, permission: 'payroll:read' },
  { to: '/payslips', label: 'สลิปเงินเดือน', icon: <Banknote className="h-4 w-4" />, permission: 'payslip:read' },
  { to: '/reports', label: 'รายงาน', icon: <FileText className="h-4 w-4" />, permission: 'report:read' },
  { to: '/settings', label: 'ตั้งค่า', icon: <SettingsIcon className="h-4 w-4" />, permission: 'settings:read' },
];

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'ผู้ดูแลระบบสูงสุด',
  ADMIN: 'ผู้ดูแลระบบ',
  HR: 'ฝ่ายบุคคล',
  PAYROLL: 'ฝ่ายเงินเดือน',
  VIEWER: 'ผู้อ่านอย่างเดียว',
};

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const { logout } = useAuth();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
      return;
    }
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      toast.success('เปลี่ยนรหัสผ่านเรียบร้อยแล้ว กรุณาเข้าสู่ระบบใหม่');
      onOpenChange(false);
      // Changing the password revokes every session, including this one.
      await logout();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="เปลี่ยนรหัสผ่าน" description="ระบบจะออกจากระบบทุกอุปกรณ์หลังเปลี่ยนรหัสผ่าน">
        <form onSubmit={submit} className="space-y-4">
          <Field label="รหัสผ่านปัจจุบัน" required>
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label="รหัสผ่านใหม่" required hint="อย่างน้อย 8 ตัวอักษร ประกอบด้วยตัวอักษรและตัวเลข">
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </Field>
          <Field label="ยืนยันรหัสผ่านใหม่" required error={error}>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" loading={saving}>
              บันทึก
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AppLayout() {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [passwordOpen, setPasswordOpen] = React.useState(false);

  const visibleItems = NAV_ITEMS.filter((item) => can(item.permission));

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
      isActive
        ? 'bg-primary text-primary-foreground'
        : 'text-slate-600 hover:bg-accent hover:text-primary'
    );

  return (
    <div className="min-h-screen bg-slate-50/70">
      <header className="no-print sticky top-0 z-40 border-b border-border bg-white">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 lg:px-6">
          <button
            type="button"
            className="flex items-center gap-2.5"
            onClick={() => navigate('/')}
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Wallet className="h-5 w-5" />
            </span>
            <span className="hidden text-left sm:block">
              <span className="block text-sm font-semibold leading-tight text-foreground">
                ระบบบริหารเงินเดือน
              </span>
              <span className="block text-xs leading-tight text-muted-foreground">
                Payroll Management
              </span>
            </span>
          </button>

          <nav className="ml-4 hidden flex-1 items-center gap-1 lg:flex">
            {visibleItems.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass}>
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm transition hover:bg-accent">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {user?.firstName?.[0] ?? '?'}
                  </span>
                  <span className="hidden text-left md:block">
                    <span className="block text-xs font-medium leading-tight">
                      {user?.firstName} {user?.lastName}
                    </span>
                    <span className="block text-[11px] leading-tight text-muted-foreground">
                      {ROLE_LABELS[user?.role ?? ''] ?? user?.role}
                    </span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="z-50 min-w-[220px] rounded-lg border border-border bg-white p-1.5 shadow-pop"
                >
                  <div className="px-2.5 py-2">
                    <p className="text-sm font-medium">
                      {user?.firstName} {user?.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground">{user?.email}</p>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-accent"
                    onSelect={() => setPasswordOpen(true)}
                  >
                    <KeyRound className="h-4 w-4" />
                    เปลี่ยนรหัสผ่าน
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-danger outline-none hover:bg-danger-soft"
                    onSelect={() => void logout()}
                  >
                    <LogOut className="h-4 w-4" />
                    ออกจากระบบ
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>

            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="เมนู"
            >
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {mobileOpen && (
          <nav className="border-t border-border bg-white px-4 py-3 lg:hidden">
            <div className="grid gap-1">
              {visibleItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={linkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              ))}
            </div>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-7 lg:px-6">
        <Outlet />
      </main>

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </div>
  );
}
