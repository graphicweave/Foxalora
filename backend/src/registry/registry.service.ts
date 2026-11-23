import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { Database, TlsPolicy } from '../database/schema';
import { TenantDb } from '../database/tenant-db';
import { isProduction, ServerValidationError, validateServerInput, type ServerInput } from './server-validation';

export interface MailServer {
  id: string;
  tenantId: string;
  imapHost: string;
  imapPort: number;
  imapTls: TlsPolicy;
  smtpHost: string;
  smtpPort: number;
  smtpTls: TlsPolicy;
  allowPrivate: boolean;
  /** The server keeps its own copy of sent mail (OPEN-4). */
  savesSent: boolean;
}

interface ServerRow {
  id: string; tenant_id: string; imap_host: string; imap_port: number; imap_tls: TlsPolicy;
  smtp_host: string; smtp_port: number; smtp_tls: TlsPolicy; allow_private: boolean; saves_sent?: boolean;
}

const toServer = (r: ServerRow): MailServer => ({
  id: r.id, tenantId: r.tenant_id, imapHost: r.imap_host, imapPort: r.imap_port, imapTls: r.imap_tls,
  smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpTls: r.smtp_tls, allowPrivate: r.allow_private,
  savesSent: r.saves_sent === true, // not returned by the login lookup, which does not need it
});

export class NotFoundError extends Error {}

const uniqueName = (e: unknown): never => {
  if ((e as { code?: string })?.code === '23505') throw new ServerValidationError('Another server already has that name.');
  throw e;
};

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Lower-cased email domain, or ServerValidationError. */
export function normalizeDomain(input: unknown): string {
  const domain = String(input ?? '').trim().toLowerCase();
  if (!DOMAIN.test(domain) || domain.length > 253) throw new ServerValidationError(`domain "${domain.slice(0, 60)}" is invalid`);
  return domain;
}

/**
 * Admin-managed mail server registry (FOX-006/007). Users never supply a server:
 * login resolves the email domain through resolve_mail_domain(), and everything
 * after login reads the server inside the session's tenant context.
 */
@Injectable()
export class RegistryService {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Domain -> tenant and server, for login. Null for unknown domains or suspended tenants. */
  async resolveEmail(email: string): Promise<MailServer | null> {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!DOMAIN.test(domain) || domain.length > 253) return null;
    const r = await sql<ServerRow & { mail_server_id: string }>`
      SELECT tenant_id, mail_server_id AS id, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls, allow_private
        FROM resolve_mail_domain(${domain})`.execute(this.db);
    return r.rows[0] ? toServer(r.rows[0]) : null;
  }

  /** Server for an authenticated session; tenant id comes from the session only. */
  async getServer(tenantId: string, serverId: string): Promise<MailServer | null> {
    const row = await this.tenantDb.run({ tenantId }, (trx) =>
      trx.selectFrom('mail_servers').selectAll().where('id', '=', serverId).executeTakeFirst());
    return row ? toServer(row) : null;
  }

  // ---- administration (CLI now, admin console in Phase 3) ----

  async createServer(tenantId: string, input: ServerInput, actor: string): Promise<MailServer> {
    const s = validateServerInput(input, { production: isProduction() });
    return this.tenantDb.run({ tenantId }, (trx) => this.insertServer(trx, tenantId, s, actor));
  }

  /** Inside an existing tenant transaction (setup wizard). `s` must come from validateServerInput. */
  async insertServer(trx: Transaction<Database>, tenantId: string, s: ServerInput, actor: string): Promise<MailServer> {
    const row = await trx.insertInto('mail_servers').values({
      tenant_id: tenantId, name: s.name, imap_host: s.imapHost, imap_port: s.imapPort, imap_tls: s.imapTls,
      smtp_host: s.smtpHost, smtp_port: s.smtpPort, smtp_tls: s.smtpTls, allow_private: s.allowPrivate, saves_sent: s.savesSent === true,
    }).returningAll().executeTakeFirstOrThrow();
    await this.audit.insert(trx, tenantId, 'registry.server_created', actor, {
      server: s.name, imap: `${s.imapHost}:${s.imapPort}/${s.imapTls}`, smtp: `${s.smtpHost}:${s.smtpPort}/${s.smtpTls}`, allowPrivate: s.allowPrivate, savesSent: s.savesSent === true,
    });
    return toServer(row);
  }

  /** Marks whether a server keeps its own copy of sent mail (OPEN-4). */
  async setSavesSent(tenantId: string, serverName: string, savesSent: boolean, actor: string): Promise<void> {
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const r = await trx.updateTable('mail_servers').set({ saves_sent: savesSent, updated_at: new Date() }).where('name', '=', serverName).returning('id').executeTakeFirst();
      if (!r) throw new ServerValidationError(`no server named "${serverName}" in this tenant`);
      await this.audit.insert(trx, tenantId, 'registry.server_updated', actor, { server: serverName, savesSent });
    });
  }

  async mapDomain(tenantId: string, domainInput: string, serverName: string, actor: string): Promise<void> {
    const domain = normalizeDomain(domainInput);
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const server = await trx.selectFrom('mail_servers').select('id').where('name', '=', serverName).executeTakeFirst();
      if (!server) throw new ServerValidationError(`no server named "${serverName}" in this tenant`);
      await this.insertDomain(trx, tenantId, domain, { id: server.id, name: serverName }, actor);
    });
  }

  /** Inside an existing tenant transaction. `domain` must come from normalizeDomain. */
  async insertDomain(trx: Transaction<Database>, tenantId: string, domain: string, server: { id: string; name: string }, actor: string) {
    await trx.insertInto('domain_mappings').values({ tenant_id: tenantId, domain, mail_server_id: server.id }).execute();
    await this.audit.insert(trx, tenantId, 'registry.domain_mapped', actor, { domain, server: server.name });
  }

  /** Changes a server's settings. `s` must come from validateServerInput. */
  async updateServer(tenantId: string, serverId: string, s: ServerInput, actor: string): Promise<void> {
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const r = await trx.updateTable('mail_servers').set({
        name: s.name, imap_host: s.imapHost, imap_port: s.imapPort, imap_tls: s.imapTls,
        smtp_host: s.smtpHost, smtp_port: s.smtpPort, smtp_tls: s.smtpTls, allow_private: s.allowPrivate,
        saves_sent: s.savesSent === true, updated_at: new Date(),
      }).where('id', '=', serverId).returning('id').executeTakeFirst().catch(uniqueName);
      if (!r) throw new NotFoundError('server not found');
      await this.audit.insert(trx, tenantId, 'registry.server_updated', actor, {
        server: s.name, imap: `${s.imapHost}:${s.imapPort}/${s.imapTls}`, smtp: `${s.smtpHost}:${s.smtpPort}/${s.smtpTls}`, allowPrivate: s.allowPrivate, savesSent: s.savesSent === true,
      });
    });
  }

  /** Deletes a server that no domain uses any more (mailbox sessions on it end at their next request). */
  async deleteServer(tenantId: string, serverId: string, actor: string): Promise<void> {
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const server = await trx.selectFrom('mail_servers').select('name').where('id', '=', serverId).executeTakeFirst();
      if (!server) throw new NotFoundError('server not found');
      const used = await trx.selectFrom('domain_mappings').select('domain').where('mail_server_id', '=', serverId).execute();
      if (used.length) throw new ServerValidationError(`Remove its domains first: ${used.map((d) => d.domain).slice(0, 5).join(', ')}${used.length > 5 ? ', …' : ''}.`);
      await trx.deleteFrom('mail_servers').where('id', '=', serverId).execute();
      await this.audit.insert(trx, tenantId, 'registry.server_deleted', actor, { server: server.name });
    });
  }

  /** Maps a domain to a server of this tenant, chosen by id (admin console). */
  async mapDomainToServer(tenantId: string, domainInput: unknown, serverId: string, actor: string): Promise<string> {
    const domain = normalizeDomain(domainInput);
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const server = await trx.selectFrom('mail_servers').select(['id', 'name']).where('id', '=', serverId).executeTakeFirst();
      if (!server) throw new NotFoundError('server not found');
      await this.insertDomain(trx, tenantId, domain, server, actor).catch((e) => {
        // Domains are unique across the installation; do not reveal which tenant holds one.
        if ((e as { code?: string })?.code === '23505') throw new ServerValidationError(`The domain ${domain} cannot be added: it is already in use.`);
        throw e;
      });
    });
    return domain;
  }

  /** Removes a domain: its users can no longer sign in (sessions already open end when they expire). */
  async unmapDomain(tenantId: string, domainInput: unknown, actor: string): Promise<void> {
    const domain = normalizeDomain(domainInput);
    await this.tenantDb.run({ tenantId }, async (trx) => {
      const r = await trx.deleteFrom('domain_mappings').where('domain', '=', domain).returning('mail_server_id').executeTakeFirst();
      if (!r) throw new NotFoundError('domain not found');
      await this.audit.insert(trx, tenantId, 'registry.domain_unmapped', actor, { domain });
    });
  }

  async listServers(tenantId: string) {
    return this.tenantDb.run({ tenantId }, async (trx) => ({
      servers: await trx.selectFrom('mail_servers').selectAll().orderBy('name').execute(),
      domains: await trx.selectFrom('domain_mappings').select(['domain', 'mail_server_id']).orderBy('domain').execute(),
    }));
  }
}
