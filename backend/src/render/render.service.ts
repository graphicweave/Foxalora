import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { VALKEY } from '../common/tokens';
import { Keyring, open, seal } from '../crypto/keyring';
import { RENDER_PATH, renderConfig } from './render-config';

/** How long an issued render link stays valid if it is never opened. */
export const RENDER_TTL_MS = Math.min(Math.max(Number(process.env.RENDER_TOKEN_TTL_SECONDS ?? 60), 5), 300) * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const keyOf = (hash: string) => `fx:render:${hash}`;
const aadOf = (hash: string) => Buffer.from(`render|${hash}`);

/**
 * FOX-045 render tokens. Opening a message stores its already-sanitized HTML in Valkey,
 * sealed with the vault keyring, under a random token:
 * - one-time: the render host reads it with GETDEL, so a second load finds nothing;
 * - short-lived: it expires after RENDER_TTL_MS even if never opened;
 * - bound to one message: the token maps to exactly that message's content.
 * Only a hash of the token is stored as the key, so a Valkey dump does not contain usable links.
 * Mail content is held in memory for at most RENDER_TTL_MS and is never written to PostgreSQL.
 */
@Injectable()
export class RenderService {
  readonly config = renderConfig();
  private readonly ring = Keyring.parse(process.env.FOXALORA_VAULT_KEYS ?? process.env.SESSION_KEY, 'FOXALORA_VAULT_KEYS');

  constructor(@Inject(VALKEY) private readonly redis: Redis) {
    if (!this.config && process.env.NODE_ENV === 'production') {
      new Logger('Render').warn('No render domain: email bodies are shown on the webmail origin. Set RENDER_DOMAIN (docs/runbooks/install.md).');
    }
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** Stores the sanitized HTML and returns the one-time URL on the render origin. */
  async issue(messageId: string, html: string): Promise<string> {
    if (!this.config) throw new Error('render origin not configured');
    const token = randomBytes(32).toString('base64url');
    const hash = hashOf(token);
    const k = this.ring.active;
    const sealed = seal(k.key, Buffer.from(JSON.stringify({ m: messageId, h: html }), 'utf8'), aadOf(hash));
    await this.redis.set(keyOf(hash), `${k.id}.${sealed.toString('base64')}`, 'PX', RENDER_TTL_MS);
    return `${this.config.renderOrigin}${RENDER_PATH}${token}`;
  }

  /** Returns the content once and deletes it; null for unknown, used, expired or tampered tokens. */
  async consume(token: string): Promise<{ messageId: string; html: string } | null> {
    if (!TOKEN_RE.test(token)) return null;
    const hash = hashOf(token);
    const raw = await this.redis.getdel(keyOf(hash));
    if (!raw) return null;
    const dot = raw.indexOf('.');
    const k = dot > 0 ? this.ring.get(raw.slice(0, dot)) : undefined;
    if (!k) return null;
    try {
      const v = JSON.parse(open(k.key, Buffer.from(raw.slice(dot + 1), 'base64'), aadOf(hash)).toString('utf8'));
      return typeof v?.m === 'string' && typeof v?.h === 'string' ? { messageId: v.m, html: v.h } : null;
    } catch {
      return null;
    }
  }
}
