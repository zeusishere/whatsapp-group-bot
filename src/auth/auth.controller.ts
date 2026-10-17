import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService, toAuthUser } from './auth.service.js';
import { AuthUser } from './auth.types.js';
import { CurrentUser, Public, Roles } from './decorators.js';
import { CreateUserDto, LoginDto, RegisterDto } from './dto/auth.dto.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({
    summary: 'Self-register. The first user becomes admin; later sign-ups need auth.allowRegistration',
  })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange email + password for a JWT access token' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'The authenticated user' })
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @ApiBearerAuth()
  @Roles('admin')
  @Post('users')
  @ApiOperation({ summary: 'Admin only: create a user' })
  async createUser(@Body() dto: CreateUserDto) {
    return toAuthUser(await this.auth.createUser(dto.email, dto.password, dto.role ?? 'user'));
  }
}
