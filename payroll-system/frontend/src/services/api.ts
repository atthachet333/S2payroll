import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:2234';

const ACCESS_TOKEN_KEY = 'payroll.accessToken';
const REFRESH_TOKEN_KEY = 'payroll.refreshToken';
let tokenGeneration = 0;

export const tokenStore = {
  get generation(): number {
    return tokenGeneration;
  },
  get access(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  get refresh(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(accessToken: string, refreshToken: string) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    tokenGeneration += 1;
  },
  clear() {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    tokenGeneration += 1;
  },
};

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  (config as InternalAxiosRequestConfig & { _authGeneration?: number })._authGeneration = tokenStore.generation;
  const token = tokenStore.access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Infrastructure-level failures, translated for the people who actually read
 * them. These carry a technically accurate message that means nothing to a
 * payroll clerk - ROUTE_NOT_FOUND surfaced verbatim as
 * "POST /api/employees/<id>/attendance not found" inside a save dialog, which
 * reads as a broken app rather than as a server that needs redeploying.
 */
const INFRASTRUCTURE_MESSAGES: Record<string, string> = {
  ROUTE_NOT_FOUND:
    'เซิร์ฟเวอร์ยังไม่รองรับคำสั่งนี้ (เวอร์ชันบนเซิร์ฟเวอร์ยังไม่อัปเดต) กรุณาแจ้งผู้ดูแลระบบ',
  INTERNAL_ERROR: 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง',
};

/** Extract the API's structured error message for display in a toast. */
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { code?: string; message?: string; details?: { path: string; message: string }[] } }
      | undefined;
    if (data?.error?.details?.length) {
      return data.error.details.map((d) => d.message).join(', ');
    }
    const code = data?.error?.code;
    if (code && INFRASTRUCTURE_MESSAGES[code]) return INFRASTRUCTURE_MESSAGES[code];
    if (data?.error?.message) return data.error.message;
    if (error.code === 'ERR_NETWORK') return 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
    // An axios message such as "Request failed with status code 500" is not
    // something to put in front of a user either.
    return 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
  }
  return error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}

/** The API's machine-readable error code, for branching on a specific failure. */
export function apiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const data = error.response?.data as { error?: { code?: string } } | undefined;
  return data?.error?.code ?? null;
}

/**
 * The API's structured `details` payload, when there is one.
 *
 * Some errors carry a pointer rather than just prose - a duplicate attendance
 * day, for instance, returns the id of the record that already exists so the UI
 * can offer to open it instead of leaving the user to go and find it.
 */
export function apiErrorDetails(error: unknown): unknown {
  if (!axios.isAxiosError(error)) return null;
  const data = error.response?.data as { error?: { details?: unknown } } | undefined;
  return data?.error?.details ?? null;
}

let onSessionExpired: (() => void) | null = null;
export const setSessionExpiredHandler = (handler: () => void) => {
  onSessionExpired = handler;
};

let onPasswordChangeRequired: (() => void) | null = null;
export const setPasswordChangeRequiredHandler = (handler: () => void) => {
  onPasswordChangeRequired = handler;
};

// Single-flight refresh: concurrent 401s wait on one refresh call rather than
// each firing their own and invalidating the rotating refresh token.
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) throw new Error('No refresh token');

  const response = await axios.post(`${API_URL}/api/auth/refresh`, { refreshToken });
  const { accessToken, refreshToken: nextRefresh } = response.data as {
    accessToken: string;
    refreshToken: string;
  };
  tokenStore.set(accessToken, nextRefresh);
  return accessToken;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & {
      _retried?: boolean;
      _authGeneration?: number;
    };
    const responseData = error.response?.data as { error?: { code?: string } } | undefined;

    if (error.response?.status === 403 && responseData?.error?.code === 'PASSWORD_CHANGE_REQUIRED') {
      onPasswordChangeRequired?.();
      return Promise.reject(error);
    }

    const isAuthCall = original?.url?.includes('/api/auth/');
    if (error.response?.status !== 401 || original?._retried || isAuthCall) {
      return Promise.reject(error);
    }

    original._retried = true;

    try {
      refreshPromise = refreshPromise ?? refreshAccessToken();
      const token = await refreshPromise;
      refreshPromise = null;
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    } catch (refreshError) {
      refreshPromise = null;
      // A stale restore request may finish after a fresh credential login.
      // Never let that old failure clear the newer session.
      if (original?._authGeneration === tokenStore.generation) {
        tokenStore.clear();
        onSessionExpired?.();
      }
      return Promise.reject(refreshError);
    }
  }
);

/** Trigger a browser download for an endpoint that returns a file. */
export async function downloadFile(url: string, filename: string): Promise<void> {
  const response = await api.get(url, { responseType: 'blob' });
  const blobUrl = window.URL.createObjectURL(new Blob([response.data]));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(blobUrl);
}
