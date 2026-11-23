/** Admin console API (/api/v1/admin). Uses the admin session cookie, separate from mailbox sign-in. */
import type { TestResult } from '../setup/setup-api';

export interface AdminMe { email: string; role: 'owner' | 'admin'; stage: 'password' | 'full'; twoStepEnabled: boolean }
export interface AdminServer {
  id: string; name: string;
  imapHost: string; imapPort: number; imapTls: 'tls' | 'starttls';
  smtpHost: string; smtpPort: number; smtpTls: 'tls' | 'starttls';
  allowPrivate: boolean; savesSent: boolean; domains: string[];
}
export type ServerForm = Omit<AdminServer, 'id' | 'domains'>;
export interface AuditEntry { at: string; type: string; actor: string; details: Record<string, unknown> }
export interface AuditFilter { type?: string; from?: string; to?: string; q?: string; page?: number }

export class AdminError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'foxalora', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json())?.error?.message ?? msg; } catch { /* not JSON */ }
    throw new AdminError(res.status, msg);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const auditQuery = (f: AuditFilter) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') q.set(k, String(v));
  return q.toString();
};

export const adminApi = {
  me: () => call<AdminMe>('GET', '/admin/auth/me'),
  login: (email: string, password: string) => call<{ next: 'enroll' | 'code' }>('POST', '/admin/auth/login', { email, password }),
  enroll: () => call<{ secret: string; otpauthUrl: string; qrSvg: string }>('POST', '/admin/auth/enroll'),
  verify: (code: string) => call<{ signedIn: true; backupCodes?: string[] }>('POST', '/admin/auth/verify', { code }),
  logout: () => call<void>('POST', '/admin/auth/logout'),
  servers: () => call<{ servers: AdminServer[] }>('GET', '/admin/servers'),
  createServer: (s: ServerForm) => call<{ id: string }>('POST', '/admin/servers', s),
  updateServer: (id: string, s: ServerForm) => call<void>('PUT', `/admin/servers/${id}`, s),
  deleteServer: (id: string) => call<void>('DELETE', `/admin/servers/${id}`),
  testServer: (server: ServerForm, mailbox?: { email: string; password: string }) => call<TestResult>('POST', '/admin/servers/test', { server, mailbox }),
  addDomain: (domain: string, serverId: string) => call<{ domain: string }>('POST', '/admin/domains', { domain, serverId }),
  removeDomain: (domain: string) => call<void>('DELETE', `/admin/domains/${encodeURIComponent(domain)}`),
  audit: (f: AuditFilter) => call<{ total: number; page: number; pageSize: number; items: AuditEntry[] }>('GET', `/admin/audit?${auditQuery(f)}`),
  exportUrl: (f: AuditFilter) => `/api/v1/admin/audit/export?${auditQuery({ ...f, page: undefined })}`,
};
