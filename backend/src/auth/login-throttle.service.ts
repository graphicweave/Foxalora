import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { VALKEY } from '../common/tokens';

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

export interface ThrottleDecision {
  /** Hard block for this IP: answer 429 without trying the password. */
  blocked: boolean;
  /** Wait this long before checking the password (growing with recent failures). */
  delayMs: number;
}

/**
 * Key for an IP address: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 by its /64 network,
 * because one customer usually controls a whole /64 and could otherwise rotate addresses.
 */
export function ipKey(ip: string): string {
  const v = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!v.includes(':')) return v;
  const [head, tail = ''] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = v.includes('::') && tail ? tail.split(':') : [];
  const groups = v.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Login throttling shared across instances through Valkey (FOX-014, fixes D5).
 * There is no account lockout: failures add a growing delay, keyed mainly by
 * account+IP, so an attacker cannot lock a real user out. Only an IP that keeps
 * failing gets a hard block. Limits come from the environment for now; the admin
 * console will expose them (Phase 3).
 *
 * Every attempt is counted atomically when it starts (check), before the password is tried, and
 * a successful login takes its count back. Counting only after a failure let many simultaneous
 * attempts all pass the check (internal security test, 2026-11-23: 60 parallel guesses, all tried).
 */
@Injectable()
export class LoginThrottleService {
  readonly windowMs = num('LOGIN_WINDOW_MINUTES', 15) * 60_000;
  readonly ipMaxFailures = num('LOGIN_IP_MAX_FAILURES', 50);
  readonly freeFailures = num('LOGIN_FREE_FAILURES', 3);
  readonly baseDelayMs = num('LOGIN_DELAY_BASE_MS', 500);
  readonly maxDelayMs = num('LOGIN_DELAY_MAX_MS', 8000);

  constructor(@Inject(VALKEY) private readonly redis: Redis) {}

  private keys(account: string, ip: string) {
    // Hashed so Valkey never holds a list of email addresses and IPs in clear.
    const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);
    const net = ipKey(ip);
    return { pair: `fx:lf:p:${h(`${account}|${net}`)}`, ip: `fx:lf:i:${h(net)}`, account: `fx:lf:a:${h(account)}` };
  }

  /** Counts this attempt and decides from the attempts that came before it. */
  async check(account: string, ip: string): Promise<ThrottleDecision> {
    const k = this.keys(account, ip);
    const m = this.redis.multi();
    for (const key of [k.pair, k.ip, k.account]) m.incr(key).pexpire(key, this.windowMs);
    const res = (await m.exec()) ?? [];
    const [pair, byIp, byAccount] = [0, 2, 4].map((i) => Math.max(0, Number(res[i]?.[1] ?? 1) - 1));
    if (byIp >= this.ipMaxFailures) return { blocked: true, delayMs: 0 };
    // The account counter is shared by all IPs, so it grows slowly (one step per 5
    // failures): it slows distributed guessing without letting one attacker freeze a user.
    const level = Math.max(pair, Math.floor(byIp / 2), Math.floor(byAccount / 5)) - this.freeFailures;
    const delayMs = level < 0 ? 0 : Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** level);
    return { blocked: false, delayMs };
  }

  /** A successful login clears the account+IP counter and takes back its own attempt elsewhere. */
  async recordSuccess(account: string, ip: string): Promise<void> {
    const k = this.keys(account, ip);
    await this.redis.multi().del(k.pair).decr(k.ip).decr(k.account).exec();
  }
}
