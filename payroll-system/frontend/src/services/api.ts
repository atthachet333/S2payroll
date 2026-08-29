import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:2234';

const ACCESS_TOKEN_KEY = 'payroll.accessToken';
const REFRESH_TOKEN_KEY = 'payroll.refreshToken';

export const tokenStore = {
  get access(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },
  get refresh(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },
  set(accessToken: string, refreshToken: string) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

export const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 60_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.access;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Extract the API's structured error message for display in a toast. */
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | { error?: { message?: string; details?: { path: string; message: string }[] } }
      | undefined;
    if (data?.error?.details?.length) {
      return data.error.details.map((d) => d.message).join(', ');
    }
    if (data?.error?.message) return data.error.message;
    if (error.code === 'ERR_NETWORK') return 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
    return error.message;
  }
  return error instanceof Error ? error.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';
}

let onSessionExpired: (() => void) | null = null;
export const setSessionExpiredHandler = (handler: () => void) => {
  onSessionExpired = handler;
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
    const original = error.config as InternalAxiosRequestConfig & { _retried?: boolean };

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
      tokenStore.clear();
      onSessionExpired?.();
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
