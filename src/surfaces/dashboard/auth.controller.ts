/**
 * `/dashboard/v1/auth` (spec 7.2). Thin: validation, policy, shape mapping and cookies.
 *
 * Not implemented yet, because they need email delivery (Phase 8 notifications):
 * `forgot-password`, `reset-password`, `verify-email`. See docs/ARCHITECTURE.md.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CurrentMerchantUser } from '../../common/auth/current-principal.decorator';
import type { MerchantUserPrincipal } from '../../common/auth/principal';
import { Audited } from '../../common/audit/audited.decorator';
import { Authenticated, Public, RequiresStepUp } from '../../common/authz/policy.decorators';
import { ApiEnvelopedResponses } from '../../common/http/response-schema.decorator';
import { AuthService } from '../../modules/auth/auth.service';
import { MfaService } from '../../modules/auth/mfa.service';
import { SessionService } from '../../modules/auth/session.service';
import { InvitationsService } from '../../modules/merchants/invitations.service';
import { OnboardingService } from '../../modules/merchants/onboarding.service';
import { merchantSchema } from '../../modules/merchants/merchant.views';
import {
  loginResponseSchema,
  loginView,
  okSchema,
  sessionSchema,
  sessionView,
  tokensSchema,
  tokensView,
} from '../shared/auth.views';
import {
  countrySchema,
  currencySchema,
  emailSchema,
  idParamSchema,
  nameSchema,
  newPasswordSchema,
  passwordSchema,
  refSchema,
  totpCodeSchema,
} from '../shared/schemas';
import {
  clearSessionCookies,
  clientMeta,
  readRefreshToken,
  setSessionCookies,
} from '../shared/session-cookies';

class RegisterDto extends createZodDto(
  z.strictObject({
    email: emailSchema,
    password: newPasswordSchema,
    name: nameSchema,
    merchant: z.strictObject({
      legalName: nameSchema,
      tradingName: nameSchema.optional(),
      country: countrySchema,
      defaultCurrency: currencySchema,
    }),
  })
) {}

class LoginDto extends createZodDto(
  z.strictObject({ email: emailSchema, password: passwordSchema, merchant: refSchema.optional() })
) {}

class MfaVerifyDto extends createZodDto(
  z.strictObject({ mfaToken: z.string().min(1).max(256), code: totpCodeSchema })
) {}

class MfaEnrollDto extends createZodDto(z.strictObject({ code: totpCodeSchema.optional() })) {}
class MfaDisableDto extends createZodDto(z.strictObject({ code: totpCodeSchema })) {}
class SessionParamDto extends createZodDto(idParamSchema) {}

class AcceptInviteDto extends createZodDto(
  z.strictObject({
    token: z.string().min(1).max(256),
    name: nameSchema.optional(),
    password: newPasswordSchema,
  })
) {}

const registrationSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  merchant: merchantSchema,
});

const mfaEnrollSchema = z.object({
  status: z.enum(['pending', 'enabled']),
  secret: z.string().optional(),
  otpauthUri: z.string().optional(),
});

const meSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  merchant: z.object({ id: z.string(), status: z.string(), role: z.string() }),
  session: z.object({ id: z.string(), mfa: z.boolean(), amr: z.array(z.string()) }),
});

const acceptedInviteSchema = z.object({
  merchantId: z.string(),
  role: z.string(),
  userId: z.string(),
});

@ApiTags('Auth')
@Controller('auth')
export class DashboardAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly onboarding: OnboardingService,
    private readonly invitations: InvitationsService
  ) {}

  @Post('register')
  @Public()
  @Audited('user.registered', 'user')
  @ApiOperation({ summary: 'Create an account and a draft merchant owned by it' })
  @ApiEnvelopedResponses({ 201: registrationSchema })
  register(@Body() body: RegisterDto) {
    return this.onboarding.register(body);
  }

  @Post('login')
  @HttpCode(200)
  @Public()
  @Audited('auth.login', 'session')
  @ApiOperation({ summary: 'Log in. Returns tokens, or an MFA challenge when MFA is enabled' })
  @ApiEnvelopedResponses({ 200: loginResponseSchema })
  async login(
    @Body() body: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.auth.login('dashboard', body, clientMeta(req));
    if (result.status === 'authenticated') setSessionCookies(reply, 'dashboard', result.tokens);
    return loginView(result);
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @Public()
  @Audited('auth.mfa_verify', 'session')
  @ApiOperation({ summary: 'Complete an MFA login challenge' })
  @ApiEnvelopedResponses({ 200: loginResponseSchema })
  async verifyMfa(
    @Body() body: MfaVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    const result = await this.auth.verifyMfa('dashboard', body, clientMeta(req));
    if (result.status === 'authenticated') setSessionCookies(reply, 'dashboard', result.tokens);
    return loginView(result);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  @Authenticated()
  @Audited('auth.mfa_enroll', 'user')
  @ApiOperation({
    summary: 'Without a code: start enrollment. With a code: confirm and enable MFA',
  })
  @ApiEnvelopedResponses({ 200: mfaEnrollSchema })
  enrollMfa(@Body() body: MfaEnrollDto, @CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return this.mfa.enroll(principal, body.code);
  }

  @Post('mfa/disable')
  @HttpCode(200)
  @Authenticated()
  @RequiresStepUp()
  @Audited('auth.mfa_disabled', 'user')
  @ApiOperation({ summary: 'Disable MFA. Needs a recent login (step-up) and a current code' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async disableMfa(
    @Body() body: MfaDisableDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    await this.mfa.disable(principal, body.code);
    return { ok: true as const };
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @Audited('auth.session_refreshed', 'session')
  @ApiOperation({
    summary: 'Rotate the refresh cookie and issue a new access token (CSRF header required)',
  })
  @ApiEnvelopedResponses({ 200: tokensSchema })
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    try {
      const tokens = await this.sessions.refresh(
        'dashboard',
        readRefreshToken(req),
        clientMeta(req)
      );
      setSessionCookies(reply, 'dashboard', tokens);
      return tokensView(tokens);
    } catch (error) {
      clearSessionCookies(reply, 'dashboard');
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
    @CurrentMerchantUser() principal: MerchantUserPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply
  ) {
    await this.auth.logout(principal);
    clearSessionCookies(reply, 'dashboard');
    return { ok: true as const };
  }

  @Post('accept-invite')
  @HttpCode(200)
  @Public()
  @Audited('invitation.accepted', 'invitation')
  @ApiOperation({ summary: 'Accept a team invitation; creates the account when the email is new' })
  @ApiEnvelopedResponses({ 200: acceptedInviteSchema })
  acceptInvite(@Body() body: AcceptInviteDto) {
    return this.invitations.accept(body);
  }

  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'The current user, merchant and session' })
  @ApiEnvelopedResponses({ 200: meSchema })
  me(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    return {
      user: { id: principal.userRef, email: principal.email, name: principal.name },
      merchant: {
        id: principal.merchant.ref,
        status: principal.merchant.status,
        role: principal.role,
      },
      session: { id: principal.sessionId, mfa: principal.mfa, amr: [...principal.amr] },
    };
  }

  @Get('sessions')
  @Authenticated()
  @ApiOperation({ summary: 'Active sessions of the current user' })
  @ApiEnvelopedResponses({ 200: z.array(sessionSchema) })
  async listSessions(@CurrentMerchantUser() principal: MerchantUserPrincipal) {
    const rows = await this.sessions.listActive(principal.userId, 'dashboard');
    return rows.map((row) => sessionView(row, principal.sessionId));
  }

  @Delete('sessions/:id')
  @Authenticated()
  @Audited('auth.session_revoked', 'session')
  @ApiOperation({ summary: 'Revoke one of the current user’s sessions' })
  @ApiEnvelopedResponses({ 200: okSchema })
  async revokeSession(
    @Param() params: SessionParamDto,
    @CurrentMerchantUser() principal: MerchantUserPrincipal
  ) {
    await this.auth.revokeSession(principal, params.id);
    return { ok: true as const };
  }
}
