import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client?: Redis;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('REDIS_URL');
    if (url) {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });
    }
  }

  isEnabled(): boolean {
    return Boolean(this.client);
  }

  getClient(): Redis {
    if (!this.client) {
      throw new Error('REDIS_URL is not configured');
    }
    return this.client;
  }

  duplicate(): Redis {
    return this.getClient().duplicate();
  }

  async incrementWindow(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.client) return null;
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
