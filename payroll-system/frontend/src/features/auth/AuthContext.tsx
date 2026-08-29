import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { authApi } from '@/services/endpoints';
import { apiErrorMessage, setSessionExpiredHandler, tokenStore } from '@/services/api';
import type { SessionUser } from '@/types';

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** True when the signed-in role carries the given "resource:action" permission. */
  can: (permission: string) => boolean;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const navigate = useNavigate();

  // Restore the session on boot when a token is already in storage.
  React.useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!tokenStore.access) {
        setLoading(false);
        return;
      }
      try {
        const me = await authApi.me();
        if (!cancelled) setUser(me);
      } catch {
        tokenStore.clear();
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  // The axios layer calls this when a refresh attempt finally fails.
  React.useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null);
      toast.error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
      navigate('/login', { replace: true });
    });
  }, [navigate]);

  const login = React.useCallback(
    async (email: string, password: string) => {
      const result = await authApi.login(email, password);
      tokenStore.set(result.accessToken, result.refreshToken);
      setUser(result.user);
    },
    []
  );

  const logout = React.useCallback(async () => {
    try {
      await authApi.logout(tokenStore.refresh);
    } catch (err) {
      // A failed logout call must not trap the user in the app.
      console.warn(apiErrorMessage(err));
    } finally {
      tokenStore.clear();
      setUser(null);
      navigate('/login', { replace: true });
    }
  }, [navigate]);

  const can = React.useCallback(
    (permission: string) => user?.permissions.includes(permission) ?? false,
    [user]
  );

  const value = React.useMemo(
    () => ({ user, loading, login, logout, can }),
    [user, loading, login, logout, can]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
