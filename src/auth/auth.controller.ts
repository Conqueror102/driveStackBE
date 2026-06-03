import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SafeUser } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { LocalAuthGuard } from './guards/local-auth.guard';

type LoginRequest = Request & { user: SafeUser };

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register(dto, this.requestContext(req));
  }

  @UseGuards(LocalAuthGuard)
  @Post('login')
  login(@Req() req: LoginRequest, @Body() _dto: LoginDto) {
    return this.authService.login(req.user, this.requestContext(req));
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: SafeUser) {
    return this.authService.findMe(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@CurrentUser() user: SafeUser, @Req() req: Request) {
    return this.authService.logout(user.id, this.requestContext(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('email/request-verification')
  requestEmailVerification(@CurrentUser() user: SafeUser, @Req() req: Request) {
    return this.authService.requestEmailVerification(user.id, this.requestContext(req));
  }

  @Post('email/verify')
  verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.authService.verifyEmail(dto.token, this.requestContext(req));
  }

  @Post('password/request-reset')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto, @Req() req: Request) {
    return this.authService.requestPasswordReset(dto.email, this.requestContext(req));
  }

  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(dto.token, dto.password, this.requestContext(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('password/change')
  changePassword(@CurrentUser() user: SafeUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    return this.authService.changePassword(user.id, dto, this.requestContext(req));
  }

  private requestContext(req: Request) {
    return {
      ipAddress: req.ip || req.socket.remoteAddress,
      userAgent: req.get('user-agent'),
    };
  }
}
