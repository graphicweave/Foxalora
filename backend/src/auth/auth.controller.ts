import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomInt } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { RegistryService } from '../registry/registry.service';
import { AuthedRequest, AuthGuard, COOKIE_NAME, hasCsrfHeader } from './auth.guard';
import { loginFailureReason } from './login-reason';
import { LoginThrottleService } from './login-throttle.service';
import { VaultService } from './vault.service';

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
// AUTH-012: ONE generic message for every failure reason (unknown domain, bad
// password, server down, blocked destination) so nothing can be enumerated.
const GENERIC_FAIL = 'Login failed. Check your email address and password.';
// FOX-008: failures never answer faster than this (+ jitter), so an unmapped domain
// is not distinguishable from a wrong password by timing.
const MIN_FAILURE_MS = Number(process.env.LOGIN_MIN_FAILURE_MS ?? 1200);

/**
 * Rule 6 by timing: a wrong password costs a round trip to the mail server, which usually adds its
 * own failure delay (Dovecot: about 2 s), while an unknown domain is decided at once. In the
 * 2026-11-23 internal test the medians were 2.1 s and 10.7 s, enough to list hosted domains.
 * Failures that never reach a mail server are therefore padded to a running average of how long
 * real password rejections take on this server.
 */
export class FailureTiming {
  private avg: number;
  constructor(private readonly floorMs = MIN_FAILURE_MS, private readonly capMs = 15_000) {
    this.avg = floorMs;
  }
  /** Records how long a mail server took to reject a password. */
  observe(ms: number) {
    this.avg = Math.min(this.capMs, Math.max(this.floorMs, this.avg * 0.8 + ms * 0.2));
  }
  /** How long a failure decided without a mail server should take, with jitter. */
  target(): number {
    return Math.round(this.avg + randomInt(0, Math.max(300, Math.round(this.avg * 0.2))));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Controller('auth')
export class AuthController {
  private log = new Logger('Auth');
  private readonly timing = new FailureTiming();

  constructor(
    private vault: VaultService,
    private registry: RegistryService,
    private mail: MailService,
    private throttle: LoginThrottleService,
    private audit: AuditService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: unknown; password?: unknown }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const started = Date.now();
    let extraMs = 0; // throttle delay, already spent and the same for every failure kind
    // `targetMs`: failures that never reached a mail server wait as long as a typical rejection.
    const fail = async (status: 400 | 401 = 401, targetMs = MIN_FAILURE_MS): Promise<never> => {
      await sleep(Math.max(0, targetMs + extraMs - (Date.now() - started)) + randomInt(0, 300));
      throw status === 400 ? new BadRequestException(GENERIC_FAIL) : new UnauthorizedException(GENERIC_FAIL);
    };

    if (!hasCsrfHeader(req)) return fail();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!EMAIL_RE.test(email) || email.length > 320 || !password || password.length > 1024) return fail(400);

    const ip = req.ip ?? 'unknown';
    const decision = await this.throttle.check(email, ip);
    if (decision.blocked) {
      this.log.warn('login throttled: IP over failure limit');
      throw new HttpException('Too many attempts. Try again later.', 429);
    }
    if (decision.delayMs) await sleep(decision.delayMs);
    extraMs = decision.delayMs;

    const server = await this.registry.resolveEmail(email);
    if (!server) {
      this.log.warn('login rejected: domain not mapped to an active tenant');
      return fail(401, this.timing.target());
    }

    const verifyStarted = Date.now();
    try {
      await this.mail.verifyLogin({ email, password, server });
    } catch (e: unknown) {
      // Log reason class only. Never log the password or raw error objects from
      // the mail libraries (they may echo server responses).
      const reason = loginFailureReason(e);
      const passwordRejected = /^(imap|smtp)_auth:/.test(reason);
      if (passwordRejected) this.timing.observe(Date.now() - verifyStarted);
      this.log.warn(`login failed (${reason})`);
      await this.audit.record(server.tenantId, 'auth.login_failed', email, { ip, reason, delayedMs: decision.delayMs });
      // Quick failures for other reasons (blocked destination, refused connection) look like a rejection too.
      return fail(401, passwordRejected ? MIN_FAILURE_MS : this.timing.target());
    }

    await this.throttle.recordSuccess(email, ip);
    // D13: a login always replaces whatever session the browser had.
    await this.vault.destroy(req.cookies?.[COOKIE_NAME]);
    const sid = await this.vault.create({ email, password, tenantId: server.tenantId, serverId: server.id });
    res.cookie(COOKIE_NAME, sid, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: this.vault.absoluteMs,
    });
    await this.audit.record(server.tenantId, 'auth.login', email, { ip });
    return { email };
  }

  /** Works with an expired session too, so the cookie is always cleared (D13). */
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!hasCsrfHeader(req)) throw new UnauthorizedException();
    const sid = req.cookies?.[COOKIE_NAME];
    const session = await this.vault.get(sid);
    await this.vault.destroy(sid);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    if (session) await this.audit.record(session.tenantId, 'auth.logout', session.email, { ip: req.ip ?? 'unknown' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: AuthedRequest) {
    return { email: req.mailbox.email }; // never returns the password
  }
}
