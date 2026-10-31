// Access token lives only in memory (never localStorage). The refresh credential is an HttpOnly cookie
// the browser attaches by itself; JavaScript can neither read nor steal it.
let accessToken: string | null = null;
let refreshing: Promise<Session | null> | null = null;

export interface SessionUser { id: string; email: string; name: string; role: 'SUPER_ADMIN' | 'BOOKING_STAFF' | 'FINANCE_STAFF' }
export interface Session { accessToken: string; user: SessionUser }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const messageOf = (body: unknown, fallback: string): string => {
  const m = (body as { message?: string | string[] } | null)?.message;
  return Array.isArray(m) ? m.join(' ') : (m ?? fallback);
};

async function send<T>(path: string, method: string, body?: unknown, token?: string | null, file?: File): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(file ? { 'Content-Type': file.type || 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Requested-With': 'mtt-admin',
    },
    body: file ?? (body !== undefined ? JSON.stringify(body) : undefined),
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, messageOf(data, 'Request failed'));
  return data as T;
}

/** Single-flight refresh: concurrent 401s share one rotation (a second parallel call would look like token reuse). */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= send<Session>('/auth/refresh', 'POST')
    .then((s) => { accessToken = s.accessToken; return s; })
    .catch(() => { accessToken = null; return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function login(email: string, password: string): Promise<Session> {
  const s = await send<Session>('/auth/login', 'POST', { email, password });
  accessToken = s.accessToken;
  return s;
}

export async function logout(): Promise<void> {
  try { await send('/auth/logout', 'POST'); } finally { accessToken = null; }
}

export const publicApi = {
  get: <T,>(path: string) => send<T>(path, 'GET'),
  post: <T,>(path: string, body: unknown) => send<T>(path, 'POST', body),
};

/** Authenticated call with one transparent refresh-and-retry on 401. */
export async function adminApi<T>(path: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, file?: File): Promise<T> {
  try {
    if (!accessToken) throw new ApiError(401, 'no token');
    return await send<T>(path, method, body, accessToken, file);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const s = await refreshSession();
    if (!s) throw new ApiError(401, 'Session expired');
    return send<T>(path, method, body, s.accessToken, file);
  }
}

/** Uploads a file as the raw request body (used for airline logos). */
export const adminUpload = <T,>(path: string, file: File) => adminApi<T>(path, 'POST', undefined, file);

/** For file downloads, which cannot go through adminApi. Call adminApi first so an expired token is refreshed. */
export const currentToken = (): string | null => accessToken;

/** Downloads a file that needs the sign-in token (it cannot be a plain link) and hands it to the browser. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  await adminApi('/auth/me'); // refreshes an expired token first
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${accessToken}`, 'X-Requested-With': 'mtt-admin' }, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, messageOf(await res.json().catch(() => null), 'The file could not be downloaded.'));
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
