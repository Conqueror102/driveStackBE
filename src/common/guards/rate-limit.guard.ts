import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { RedisService } from '../../redis/redis.service';

type Bucket = {
  count: number;
  resetAt: number;
};

const WINDOW_MS = 60 * 1000;
const DEFAULT_LIMIT = 120;
const AUTH_LIMIT = 20;
const MUTATION_LIMIT = 60;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path === '/payments/webhook') return true;
    const key = this.keyFor(req);
    const limit = this.limitFor(req);
    const redisCount = await this.redis.incrementWindow(`rate-limit:${key}`, WINDOW_MS / 1000);
    if (redisCount !== null) {
      if (redisCount > limit) {
        throw new HttpException('Too many requests', 429);
      }
      return true;
    }

    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      this.prune(now);
      return true;
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      throw new HttpException('Too many requests', 429);
    }

    return true;
  }

  private keyFor(req: Request): string {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    return `${ip}:${req.method}:${req.route?.path || req.path}`.replace(/\s+/g, '-');
  }

  private limitFor(req: Request): number {
    if (req.path === '/payments/checkout' && req.method === 'POST') return 3;
    if (req.path.startsWith('/auth')) return AUTH_LIMIT;
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) return MUTATION_LIMIT;
    return DEFAULT_LIMIT;
  }

  private prune(now: number): void {
    if (this.buckets.size < 10000) return;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
