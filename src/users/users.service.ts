import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { StalzoneUser } from 'src/stalzone/oauth/stalzone-oauth.service';

interface TokenCredentals {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByStalzoneId(id: string) {
    return await this.prisma.user.findFirst({
      where: {
        uuid: id,
      },
      select: {
        id: true,
        uuid: true,
        login: true,
        distributor_id: true,
      },
    });
  }

  async create(user: StalzoneUser) {
    const userDb = await this.prisma.user.findUnique({
      where: {
        stalzoneId: user.id,
      },
      select: {
        id: true,
        login: true,
        uuid: true,
        stalzoneId: true,
      },
    });

    if (!userDb) {
      return this.prisma.user.create({
        data: {
          uuid: user.uuid,
          distributor: user.distributor,
          distributor_id: user.distributor_id,
          login: user.login,
          stalzoneId: user.id,
        },
      });
    }

    throw new BadRequestException('Такой пользователь уже есть!');
  }

  async saveStalzoneTokens(userId: string, tokens: TokenCredentals) {
    await this.prisma.stalzoneAccount.upsert({
      where: {
        userId,
      },
      create: {
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresIn,
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresIn,
      },
    });
  }
}
