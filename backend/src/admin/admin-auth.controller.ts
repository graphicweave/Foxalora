import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Logger, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { hasCsrfHeader } from '../auth/auth.guard';
import { LoginThrottleService } from '../auth/login-throttle.service';
import { ADMIN_COOKIE, AdminSessionService } from './admin-session.service';
import { AdminAuthService, CodeRejected } from './admin-auth.service';
import { AdminGuard, AllowPasswordStage, type AdminRequest } from './admin.guard';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const GENERIC_FAIL = 'Sign-in failed. Check your email address and password.';
const MIN_FAILURE_MS = Number(process.env.LOGIN_MIN_FAILURE_MS ?? 1200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Administrator sign-in: password, then a two-step code (always required). */
@Controller('admin/auth')
export class AdminAuthController {
  private readonly log = new Logger('AdminAuth');

  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: AdminSessionService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
  ) {}

  private setCookie(res: Response, sid: string, maxAge: number) {
    res.cookie(ADMIN_COOKIE, sid, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge });
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: unknown; password?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    let extraMs = 0;
    const fail = async (): Promise<never> => {
      await sleep(Math.max(0, MIN_FAILURE_MS + extraMs - (Date.now() - started)) + randomInt(0, 300));
      throw new UnauthorizedException(GENERIC_FAIL);
    };
    if (!hasCsrfHeader(req)) return fail();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email) || email.length > 320 || !password || password.length > 1024) throw new BadRequestException(GENERIC_FAIL);

    const ip = req.ip ?? 'unknown';
    // Separate counters from mailbox logins, same rules (counted before the check, no lockout of the account).
    const decision = await this.throttle.check(`admin:${email}`, ip);
    if (decision.blocked) throw new HttpException('Too many attempts. Try again later.', 429);
    if (decision.delayMs) await sleep(decision.delayMs);
    extraMs = decision.delayMs;

    const found = await this.auth.checkPassword(email, password);
    if (!found) {
      this.log.warn('admin sign-in failed');
      return fail();
    }
    await this.throttle.recordSuccess(`admin:${email}`, ip);
    const acct = await this.auth.account(found.tenantId, found.adminId);
    if (!acct) return fail();

    await this.sessions.destroy(req.cookies?.[ADMIN_COOKIE]);
    const sid = await this.sessions.create({ adminId: found.adminId, tenantId: found.tenantId, email, role: acct.role, stage: 'password' });
    this.setCookie(res, sid, this.sessions.pendingMs);
    await this.audit.record(found.tenantId, 'admin.password_ok', `admin:${email}`, { ip });
    return { next: acct.totp_enabled_at ? 'code' : 'enroll' };
  }

  @Get('me')
  @UseGuards(AdminGuard)
  @AllowPasswordStage()
  async me(@Req() req: AdminRequest) {
    const acct = await this.auth.account(req.admin.tenantId, req.admin.adminId);
    return { email: req.admin.email, role: req.admin.role, stage: req.admin.stage, twoStepEnabled: !!acct?.totp_enabled_at };
  }

  @Post('enroll')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @AllowPasswordStage()
  async enroll(@Req() req: AdminRequest) {
    if (req.admin.stage !== 'password') throw new BadRequestException('already signed in');
    return this.auth.startEnrollment(req.admin, 'Foxalora');
  }

  @Post('verify')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @AllowPasswordStage()
  async verify(@Body() body: { code?: unknown }, @Req() req: AdminRequest, @Res({ passthrough: true }) res: Response) {
    if (req.admin.stage !== 'password') throw new BadRequestException('already signed in');
    const code = typeof body?.code === 'string' ? body.code.slice(0, 40) : '';
    const ip = req.ip ?? 'unknown';
    let result: { backupCodes?: string[] };
    try {
      result = await this.auth.verifyCode(req.admin, code, ip);
    } catch (e) {
      if (e instanceof CodeRejected) throw new UnauthorizedException('That code is not valid. Check the code in your authenticator app.');
      throw e;
    }
    const sid = await this.sessions.promote(req.adminSid, req.admin);
    this.setCookie(res, sid, this.sessions.absoluteMs);
    await this.auth.markSignedIn(req.admin);
    await this.audit.record(req.admin.tenantId, 'admin.login', `admin:${req.admin.email}`, { ip });
    return { signedIn: true, ...(result.backupCodes ? { backupCodes: result.backupCodes } : {}) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!hasCsrfHeader(req)) throw new UnauthorizedException();
    const sid = req.cookies?.[ADMIN_COOKIE];
    const s = await this.sessions.get(sid);
    await this.sessions.destroy(sid);
    res.clearCookie(ADMIN_COOKIE, { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
    if (s) await this.audit.record(s.tenantId, 'admin.logout', `admin:${s.email}`, {});
  }
}
