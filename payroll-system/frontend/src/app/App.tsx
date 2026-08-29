import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import AppLayout from '@/layouts/AppLayout';
import LoginPage from '@/pages/LoginPage';
import OverviewPage from '@/pages/OverviewPage';
import EmployeesPage from '@/pages/EmployeesPage';
import EmployeeDetailPage from '@/pages/EmployeeDetailPage';
import AttendancePage from '@/pages/AttendancePage';
import PayrollPage from '@/pages/PayrollPage';
import PayrollDetailPage from '@/pages/PayrollDetailPage';
import PayslipsPage from '@/pages/PayslipsPage';
import ReportsPage from '@/pages/ReportsPage';
import SettingsPage from '@/pages/SettingsPage';
import NotFoundPage from '@/pages/NotFoundPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => {
        // Never retry an auth or permission failure - it will not succeed.
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function FullPageLoader() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm">กำลังโหลด...</p>
      </div>
    </div>
  );
}

/** Blocks an unauthenticated visitor and optionally enforces a permission. */
function ProtectedRoute({
  children,
  permission,
}: {
  children: React.ReactNode;
  permission?: string;
}) {
  const { user, loading, can } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  if (permission && !can(permission)) return <Navigate to="/" replace />;

  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route
          path="employees"
          element={
            <ProtectedRoute permission="employee:read">
              <EmployeesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="employees/:id"
          element={
            <ProtectedRoute permission="employee:read">
              <EmployeeDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="attendance"
          element={
            <ProtectedRoute permission="attendance:read">
              <AttendancePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="payroll"
          element={
            <ProtectedRoute permission="payroll:read">
              <PayrollPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="payroll/:periodId"
          element={
            <ProtectedRoute permission="payroll:read">
              <PayrollDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="payslips"
          element={
            <ProtectedRoute permission="payslip:read">
              <PayslipsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="reports"
          element={
            <ProtectedRoute permission="report:read">
              <ReportsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="settings"
          element={
            <ProtectedRoute permission="settings:read">
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          <Toaster position="top-right" richColors closeButton duration={4000} />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
