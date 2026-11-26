import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, RegistryService } from '../registry/registry.service';
import { ServerValidationError } from '../registry/server-validation';
import { parseServer, parseTestMailbox } from '../setup/setup-input';
import { SetupService } from '../setup/setup.service';
import { AdminGuard, type AdminRequest } from './admin.guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actor = (req: AdminRequest) => `admin:${req.admin.email}`;

/** Turns registry errors into plain 400/404 answers with a readable message. */
async function handled<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ServerValidationError) throw new BadRequestException(e.message);
    if (e instanceof NotFoundError) throw new NotFoundException(e.message);
    if ((e as { code?: string })?.code === '23505') throw new BadRequestException('Another server already has that name.');
    throw e;
  }
}

function serverId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException('server not found');
  return id;
}

/** Spreadsheet programs run cells starting with = + - @ as formulas: neutralise them (CSV injection). */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseDate(v: unknown, name: string): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`invalid ${name} date`);
  return d;
}

/**
 * Admin console API (E12): mail servers, domains and the audit log of the administrator's own
 * tenant. The tenant always comes from the admin session (rule 7); every change is audited.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly registry: RegistryService,
    private readonly audit: AuditService,
    private readonly setup: SetupService,
  ) {}

  @Get('servers')
  async servers(@Req() req: AdminRequest) {
    const { servers, domains } = await this.registry.listServers(req.admin.tenantId);
    return {
      servers: servers.map((s) => ({
        id: s.id, name: s.name, imapHost: s.imap_host, imapPort: s.imap_port, imapTls: s.imap_tls,
        smtpHost: s.smtp_host, smtpPort: s.smtp_port, smtpTls: s.smtp_tls, allowPrivate: s.allow_private, savesSent: s.saves_sent,
        domains: domains.filter((d) => d.mail_server_id === s.id).map((d) => d.domain),
      })),
    };
  }

  @Post('servers')
  async createServer(@Req() req: AdminRequest, @Body() body: unknown) {
    return handled(async () => {
      const s = await this.registry.createServer(req.admin.tenantId, parseServer(body), actor(req));
      return { id: s.id };
    });
  }

  @Put('servers/:id')
  @HttpCode(204)
  async updateServer(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    await handled(() => this.registry.updateServer(req.admin.tenantId, serverId(id), parseServer(body), actor(req)));
  }

  @Delete('servers/:id')
  @HttpCode(204)
  async deleteServer(@Req() req: AdminRequest, @Param('id') id: string) {
    await handled(() => this.registry.deleteServer(req.admin.tenantId, serverId(id), actor(req)));
  }

  /** Same connection test as the setup wizard: TLS, certificate and optionally a login (password used once). */
  @Post('servers/test')
  @HttpCode(200)
  async testServer(@Body() body: { server?: unknown; mailbox?: unknown }) {
    return handled(async () => this.setup.testServer(parseServer(body?.server), parseTestMailbox(body?.mailbox)));
  }

  @Post('domains')
  async addDomain(@Req() req: AdminRequest, @Body() body: { domain?: unknown; serverId?: unknown }) {
    return handled(async () => ({ domain: await this.registry.mapDomainToServer(req.admin.tenantId, body?.domain, serverId(String(body?.serverId ?? '')), actor(req)) }));
  }

  @Delete('domains/:domain')
  @HttpCode(204)
  async removeDomain(@Req() req: AdminRequest, @Param('domain') domain: string) {
    await handled(() => this.registry.unmapDomain(req.admin.tenantId, domain, actor(req)));
  }

  @Get('audit')
  async auditLog(@Req() req: AdminRequest, @Query() q: Record<string, unknown>) {
    const page = Math.max(1, Math.min(10_000, Number(q.page) || 1));
    const pageSize = Math.max(1, Math.min(200, Number(q.pageSize) || 50));
    const r = await this.audit.list(req.admin.tenantId, this.filter(q), pageSize, (page - 1) * pageSize);
    return { total: r.total, page, pageSize, items: r.items.map((e) => ({ at: e.occurred_at, type: e.event_type, actor: e.actor, details: e.details })) };
  }

  @Get('audit/export')
  async auditExport(@Req() req: AdminRequest, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const r = await this.audit.list(req.admin.tenantId, this.filter(q), 10_000, 0);
    const lines = [['time', 'event', 'actor', 'details'].join(',')];
    for (const e of r.items) lines.push([new Date(e.occurred_at).toISOString(), e.event_type, e.actor, e.details].map(csvCell).join(','));
    await this.audit.record(req.admin.tenantId, 'admin.audit_exported', actor(req), { rows: r.items.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="foxalora-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\r\n') + '\r\n');
  }

  private filter(q: Record<string, unknown>) {
    const type = typeof q.type === 'string' && /^[a-z0-9_.]{0,60}$/.test(q.type) ? q.type : undefined;
    const text = typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 100) : undefined;
    return { type, text, from: parseDate(q.from, 'from'), to: parseDate(q.to, 'to') };
  }
}
