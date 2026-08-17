import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { StalzoneOAuthService, StalzoneUser } from './stalzone-oauth.service';
import type { Request, Response } from 'express';
import { UsersService } from 'src/users/users.service';

@Controller('auth')
export class StalzoneOAuthController {
  constructor(
    private readonly oauthService: StalzoneOAuthService,
    private readonly userService: UsersService,
  ) {}

  @Get('stalzone')
  login(@Res() res: Response) {
    const state = crypto.randomUUID();

    res.cookie('stalzone_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 5 * 60 * 1000,
    });

    return res.redirect(this.oauthService.getAuthorizationUrl(state));
  }

  @Get('stalzone/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const savedState = res.req.cookies?.stalzone_oauth_state;

    if (!state || !savedState || state !== savedState) {
      throw new BadRequestException('Invalid OAuth state');
    }

    if (!code) {
      throw new BadRequestException('Missing authorization code');
    }

    const token = await this.oauthService.exchangeCode(code);

    const stalzoneUser = await this.oauthService.getUser(token.access_token);

    const user = await this.userService.findByStalzoneId(stalzoneUser.uuid);

    const currentUser = user ?? (await this.userService.create(stalzoneUser));

    await this.userService.saveStalzoneTokens(currentUser.id, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
    });

    return res.status(200).json(currentUser);
  }
}
