import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

type RequestIdentity = {
  id?: string;
  kind?: 'admin';
};

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: RequestIdentity }>();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      finalize(() => {
        const user = req.user;
        const path = req.originalUrl || req.url;
        if (path.startsWith('/docs/api')) return;

        void this.prisma.requestLog.create({
          data: {
            userId: user?.kind === 'admin' ? undefined : user?.id,
            adminId: user?.kind === 'admin' ? user.id : undefined,
            method: req.method,
            path,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
            ipHash: this.hashIp(req.ip || req.socket.remoteAddress),
            userAgent: req.get('user-agent'),
          },
        });
      }),
    );
  }

  private hashIp(ip?: string): string | undefined {
    if (!ip) return undefined;
    const salt = this.config.get<string>('REQUEST_LOG_SALT') || this.config.get<string>('JWT_SECRET') || 'dev';
    return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
  }
}
