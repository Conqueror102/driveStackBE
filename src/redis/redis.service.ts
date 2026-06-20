import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client?: Redis;
  private disabled = false;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('REDIS_URL');
    if (url) {
      const isTls = url.startsWith('rediss://');
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 3000,
        retryStrategy: () => null,
        ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      });
      this.client.on('error', (error) => {
        this.disable(`Redis connection error: ${error.message}`);
      });
    }
  }

  async onModuleInit() {
    if (!this.client) return;

    try {
      await this.client.connect();
      await this.client.ping();
      this.logger.log('Redis connection established');
    } catch (error) {
      this.disable(`Redis is unavailable; falling back to in-memory/inline behavior: ${this.errorMessage(error)}`);
    }
  }

  isEnabled(): boolean {
    return Boolean(this.client && !this.disabled);
  }

  getClient(): Redis {
    if (!this.client || this.disabled) {
      throw new Error('Redis is not available');
    }
    return this.client;
  }

  duplicate(): Redis {
    return this.getClient().duplicate();
  }

  async incrementWindow(key: string, ttlSeconds: number): Promise<number | null> {
    if (!this.isEnabled()) return null;

    try {
      const client = this.getClient();
      const count = await client.incr(key);
      if (count === 1) {
        await client.expire(key, ttlSeconds);
      }
      return count;
    } catch (error) {
      this.disable(`Redis rate limit operation failed; using in-memory fallback: ${this.errorMessage(error)}`);
      return null;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => this.client?.disconnect());
    }
  }

  private disable(message: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.logger.warn(message);
    this.client?.disconnect();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
