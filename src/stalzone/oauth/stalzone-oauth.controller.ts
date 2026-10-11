import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { UsersService } from 'src/users/users.service';
import { StalzoneOAuthService } from './stalzone-oauth.service';

const STATE_COOKIE = 'stalzone_oauth_state';

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/auth/stalzone',
};

const sameString = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

@Controller('auth')
export class StalzoneOAuthController {
  constructor(
    private readonly oauthService: StalzoneOAuthService,
    private readonly userService: UsersService,
  ) {}

  @Get('stalzone')
  login(@Res() res: Response) {
    const state = randomUUID();
    res.cookie(STATE_COOKIE, state, {
      ...cookieOptions,
      maxAge: 5 * 60 * 1000,
    });
    return res.redirect(this.oauthService.getAuthorizationUrl(state));
  }

  @Get('stalzone/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const savedState: unknown = req.cookies?.[STATE_COOKIE];
    // state одноразовый: стираем сразу, даже если проверка не пройдёт
    res.clearCookie(STATE_COOKIE, cookieOptions);

    if (
      typeof state !== 'string' ||
      typeof savedState !== 'string' ||
      !sameString(state, savedState)
    ) {
      throw new BadRequestException('Invalid OAuth state');
    }
    if (typeof code !== 'string' || !code || code.length > 2048) {
      throw new BadRequestException('Missing authorization code');
    }

    const token = await this.oauthService.exchangeCode(code);
    const stalzoneUser = await this.oauthService.getUser(token.access_token);
    const user = await this.userService.upsertFromStalzone(stalzoneUser);

    await this.userService.saveStalzoneTokens(user.id, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? '',
      expiresIn: Number(token.expires_in ?? 0),
    });

    return res.status(200).json(user);
  }
}
