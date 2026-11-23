import { Injectable, Logger } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../database/schema';
import { TenantDb } from '../database/tenant-db';

type Detail = string | number | boolean | null;

export interface AuditFilter { type?: string; from?: Date; to?: Date; text?: string }
// Never let secrets or content into audit entries, whatever a caller passes (PRD 5.10).
const FORBIDDEN_KEY = /pass|token|secret|cookie|authorization|session|body|content|subject/i;

export function cleanDetails(details: Record<string, unknown>): Record<string, Detail> {
  const out: Record<string, Detail> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (FORBIDDEN_KEY.test(k)) continue;
    if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v as Detail;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}

@Injectable()
export class AuditService {
  private log = new Logger('Audit');

  constructor(private readonly tenantDb: TenantDb) {}

  /** Records a security event for a tenant. Failures are logged, never thrown to callers. */
  async record(tenantId: string, eventType: string, actor: string, details: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.tenantDb.run({ tenantId }, (trx) => this.insert(trx, tenantId, eventType, actor, details));
    } catch (e) {
      this.log.warn(`audit write failed for ${eventType} (${(e as Error)?.constructor?.name})`);
    }
  }

  /** Audit entries of one tenant, newest first (FOX-085). Filters: event type prefix, date range, text in actor/details. */
  async list(tenantId: string, f: AuditFilter, limit: number, offset: number) {
    return this.tenantDb.run({ tenantId }, async (trx) => {
      let q = trx.selectFrom('audit_events');
      if (f.type) q = q.where('event_type', 'like', `${f.type.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (f.from) q = q.where('occurred_at', '>=', f.from);
      if (f.to) q = q.where('occurred_at', '<', f.to);
      if (f.text) {
        const like = `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        q = q.where((eb) => eb.or([eb('actor', 'ilike', like), eb(sql<string>`details::text`, 'ilike', like)]));
      }
      const [{ total }] = await q.select((eb) => eb.fn.countAll<string>().as('total')).execute();
      const items = await q.select(['occurred_at', 'event_type', 'actor', 'details']).orderBy('occurred_at', 'desc').limit(limit).offset(offset).execute();
      return { total: Number(total), items };
    });
  }

  /** For use inside an existing tenant transaction, so the change and its audit entry commit together. */
  async insert(trx: Transaction<Database>, tenantId: string, eventType: string, actor: string, details: Record<string, unknown> = {}) {
    await trx
      .insertInto('audit_events')
      .values({ tenant_id: tenantId, event_type: eventType, actor: actor.slice(0, 320), details: JSON.stringify(cleanDetails(details)) })
      .execute();
  }
}
