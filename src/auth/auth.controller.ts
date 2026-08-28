import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  async loginUser(@Body() body: { login: string; password: string }) {
		
	}

  @Post('register')
  async registerUser(@Body() body: { login: string; password: string }) {

	}
}
