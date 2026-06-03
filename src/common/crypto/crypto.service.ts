import { InternalServerErrorException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const rawKey = configService.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      throw new Error('ENCRYPTION_KEY must be a 64-character hex string');
    }
    this.key = Buffer.from(rawKey, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    try {
      const bytes = Buffer.from(ciphertext, 'base64');
      const iv = bytes.subarray(0, 16);
      const authTag = bytes.subarray(16, 32);
      const encrypted = bytes.subarray(32);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
      throw new InternalServerErrorException('Unable to decrypt secure data');
    }
  }
}
