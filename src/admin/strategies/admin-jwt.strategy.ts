import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';

type AdminJwtPayload = {
  sub: string;
  email: string;
  tokenVersion?: number;
  type?: string;
};

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: AdminJwtPayload) {
    if (payload.type !== 'admin') {
      throw new UnauthorizedException('Invalid admin token');
    }

    const admin = await this.prisma.admin.findUnique({ where: { id: payload.sub } });
    if (!admin || admin.tokenVersion !== (payload.tokenVersion || 0)) {
      throw new UnauthorizedException('Invalid admin token');
    }
    return { ...admin, kind: 'admin' };
  }
}
