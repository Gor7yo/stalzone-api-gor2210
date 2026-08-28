import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async registerUser(body: { login: string; password: string }) {
    const user = await this.prisma.user.findFirst({
      where: {
        login: body.login,
      },
    });

    if (!user) throw new BadRequestException('Неверный логин');

		user
  }

  async loginUser(body: { login: string; password: string }) {}
}
