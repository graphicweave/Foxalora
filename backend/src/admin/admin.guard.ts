import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { hasCsrfHeader } from '../auth/auth.guard';
import { ADMIN_COOKIE, AdminSession, AdminSessionService } from './admin-session.service';

export interface AdminRequest extends Request {
  admin: AdminSession;
  adminSid: string;
}

/** Routes of the two-step sign-in itself accept a session that has only passed the password. */
export const AllowPasswordStage = () => SetMetadata('admin:allowPasswordStage', true);

/**
 * Admin console guard: the admin session cookie (never the mailbox cookie), the custom CSRF
 * header on every state-changing request, and a completed two-step sign-in. Tenant and role come
 * from the session only (CLAUDE.md rule 7).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly sessions: AdminSessionService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !hasCsrfHeader(req)) throw new ForbiddenException('CSRF check failed');
    const sid = req.cookies?.[ADMIN_COOKIE];
    const s = await this.sessions.get(sid);
    if (!s) throw new UnauthorizedException();
    const allowPassword = this.reflector.getAllAndOverride<boolean>('admin:allowPasswordStage', [ctx.getHandler(), ctx.getClass()]);
    if (s.stage !== 'full' && !allowPassword) throw new UnauthorizedException('two-step verification required');
    req.admin = s;
    req.adminSid = sid;
    return true;
  }
}
