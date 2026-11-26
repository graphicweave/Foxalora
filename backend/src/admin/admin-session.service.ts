import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { VALKEY } from '../common/tokens';

/**
 * Administrator sessions (FOX-081), apart from mailbox sessions: own cookie, own Valkey keys,
 * shorter lifetimes. No password is kept: an admin session only records who signed in.
 *
 * A session starts at stage "password" (password checked, two-step code still needed) and is
 * replaced by a new id at stage "full" once the code is confirmed, so a session id seen before the
 * second factor is worthless afterwards.
 */
export type AdminStage = 'password' | 'full';

export interface AdminSession {
  adminId: string;
  tenantId: string;
  email: string;
  role: 'owner' | 'admin';
  stage: AdminStage;
  createdAt: number;
}

const SID = /^[A-Za-z0-9_-]{43}$/;
const PREFIX = 'fx:as:';
const key = (h: string) => `${PREFIX}${h}`;

/**
 * Ends every session of one administrator (after a password reset). Sessions are stored under the
 * hash of their id, so the records are scanned; there are only a few administrators.
 */
export async function endAdminSessions(redis: Redis, adminId: string): Promise<number> {
  let ended = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 200);
    cursor = next;
    if (keys.length === 0) continue;
    const values = await redis.mget(...keys);
    const mine = keys.filter((_, i) => {
      try { return (JSON.parse(values[i] ?? 'null') as AdminSession | null)?.adminId === adminId; } catch { return false; }
    });
    if (mine.length) ended += await redis.del(...mine);
  } while (cursor !== '0');
  return ended;
}
const hashOf = (sid: string) => createHash('sha256').update(sid).digest('hex');

// Production: the __Host- prefix keeps the cookie host-only, Secure and on Path=/ (see auth.guard.ts).
export const ADMIN_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-fx_admin' : 'fx_admin';

@Injectable()
export class AdminSessionService {
  readonly idleMs = Number(process.env.ADMIN_SESSION_IDLE_MINUTES ?? 15) * 60_000;
  readonly absoluteMs = Number(process.env.ADMIN_SESSION_MAX_HOURS ?? 8) * 3_600_000;
  /** Time allowed between the password and the two-step code. */
  readonly pendingMs = 5 * 60_000;

  constructor(@Inject(VALKEY) private readonly redis: Redis) {}

  async create(s: Omit<AdminSession, 'createdAt'>): Promise<string> {
    const sid = randomBytes(32).toString('base64url');
    const rec: AdminSession = { ...s, createdAt: Date.now() };
    await this.redis.set(key(hashOf(sid)), JSON.stringify(rec), 'PX', s.stage === 'full' ? this.idleMs : this.pendingMs);
    return sid;
  }

  async get(sid: string | undefined): Promise<AdminSession | null> {
    if (!sid || !SID.test(sid)) return null;
    const k = key(hashOf(sid));
    const raw = await this.redis.get(k);
    if (!raw) return null;
    let rec: AdminSession;
    try {
      rec = JSON.parse(raw);
    } catch {
      await this.redis.del(k);
      return null;
    }
    const age = Date.now() - rec.createdAt;
    if (age > this.absoluteMs) {
      await this.redis.del(k);
      return null;
    }
    if (rec.stage === 'full') await this.redis.pexpire(k, Math.max(1, Math.min(this.idleMs, this.absoluteMs - age)));
    return rec;
  }

  /** Ends the old session and starts a new one at stage "full" (new id, fresh lifetime). */
  async promote(sid: string, s: AdminSession): Promise<string> {
    await this.destroy(sid);
    return this.create({ adminId: s.adminId, tenantId: s.tenantId, email: s.email, role: s.role, stage: 'full' });
  }

  async destroy(sid: string | undefined): Promise<void> {
    if (sid && SID.test(sid)) await this.redis.del(key(hashOf(sid)));
  }
}
