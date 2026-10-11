import {
  BadRequestException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

interface UserBody {
  login: string;
  password: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async registerUser(body: UserBody) {
    const user = await this.prisma.user.findUnique({
      where: {
        login: body.login,
      },
    });

    if (user)
      throw new BadRequestException('Пользователь с таким логином уже есть');

    // TODO: регистрация по логину/паролю не доделана — по схеме пользователь
    // создаётся только через Stalzone OAuth (нужны stalzoneId и uuid).
    throw new NotImplementedException(
      'Регистрация по логину пока не поддерживается',
    );
  }

  loginUser(): never {
    throw new NotImplementedException('Вход по логину пока не поддерживается');
  }
}
