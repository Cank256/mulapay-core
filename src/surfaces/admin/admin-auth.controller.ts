/**
 * `/admin/v1/auth` (spec 7.3): staff login with mandatory MFA, refresh, logout, me and
 * step-up. A staff login always ends in an MFA challenge; tokens are issued only by
 * `mfa/verify`, and the guard refuses admin tokens without the `mfa` claim.
 */
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentStaff } from '../../common/auth/current-principal.decorator';
import type { StaffPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { Authenticated, Public } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { AuthService } from '../../modules/auth/auth.service';
import { SessionService } from '../../modules/auth/session.service';
import {
  accessTokenSchema,
  loginResponseSchema,
  loginView,
  okSchema,
  tokensSchema,
  tokensView,
} from '../shared/auth.views';
import { emailSchema, passwordSchema, totpCodeSchema } from '../shared/schemas';
import {
  clearSessionCookies,
  clientMeta,
  readRefreshToken,
  setSessionCookies,
} from '../shared/session-cookies';

class AdminLoginDto extends createZodDto(
  z.strictObject({ email: emailSchema, password: passwordSchema })
) {}
class MfaVerifyDto extends createZodDto(
  z.strictObject({ mfaToken: z.string().min(1).max(256), code: totpCodeSchema })
) {}
class StepUpDto extends createZodDto(
  z.strictObject({ password: passwordSchema, code: totpCodeSchema })
) {}

const staffMeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  roles: z.array(z.string()),
  session: z.object({
    id: z.string(),
    mfa: z.boolean(),
    amr: z.array(z.string()),
    authenticatedAt: z.iso.datetime(),
  }),
});

@ApiTags('Auth')
@Controller('auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @Audited('auth.login', 'session')
  @ApiOperation({ summary: 'Password step of the staff login; always returns an MFA challenge' })
  @ApiEnvelopedResponses({ 200: loginResponseSchema })
  async login(@Body() body: AdminLoginDto, @Req() req: FastifyRequest) {
    return loginView(await this.auth.login('admin', body, clientMeta(req)));
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @Public()
  @Audited('auth.mfa_verify', 'session')
  @ApiOperation({ summary: 'Complete the staff login with a TOTP code' })
  @ApiEnvelopedResponses({ 200: loginResponseSchema })
  async verifyMfa(
    @Body() body: MfaVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.auth.verifyMfa('admin', body, clientMeta(req));
    if (result.status === 'authenticated') setSessionCookies(reply, 'admin', result.tokens);
    return loginView(result);
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @Audited('auth.session_refreshed', 'session')
  @ApiOperation({ summary: 'Rotate the refresh cookie (CSRF header required)' })
  @ApiEnvelopedResponses({ 200: tokensSchema })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const tokens = await this.sessions.refresh('admin', readRefreshToken(req), clientMeta(req));
      setSessionCookies(reply, 'admin', tokens);
      return tokensView(tokens);
    } catch (error) {
      clearSessionCookies(reply, 'admin');
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @Authenticated()
  @Audited('auth.logout', 'session')
  @ApiOperation({ summary: 'End the current session' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async logout(
    @CurrentStaff() principal: StaffPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    await this.auth.logout(principal);
    clearSessionCookies(reply, 'admin');
    return { ok: true as const };
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'The current staff member and session' })
  @ApiEnvelopedResponses({ 200: staffMeSchema })
  me(@CurrentStaff() principal: StaffPrincipal) {
    return {
      user: { id: principal.userRef, email: principal.email, name: principal.name },
      roles: [...principal.roles],
      session: {
        id: principal.sessionId,
        mfa: principal.mfa,
        amr: [...principal.amr],
        authenticatedAt: principal.authTime.toISOString(),
      },
    };
  }

  @Post('step-up')
  @HttpCode(200)
  @Authenticated()
  @Audited('auth.step_up', 'session')
  @ApiOperation({ summary: 'Re-authenticate with password and TOTP for sensitive actions' })
  @ApiEnvelopedResponses({ 200: accessTokenSchema })
  async stepUp(
    @Body() body: StepUpDto,
    @CurrentStaff() principal: StaffPrincipal,
    @Req() req: FastifyRequest
  ) {
    const access = await this.auth.stepUp(principal, body, clientMeta(req));
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString() };
  }
}
