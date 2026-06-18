import { Injectable, Logger } from '@nestjs/common';

export type BillingCurrency = 'NGN' | 'USD';

@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  async detectCountry(ip: string): Promise<string> {
    const normalized = this.normalizeIp(ip);
    if (this.isPrivateIp(normalized)) return 'UNKNOWN';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`https://ipapi.co/${encodeURIComponent(normalized)}/country/`, {
          headers: { 'User-Agent': 'DriveStack/1.0' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`ipapi.co returned ${response.status}`);

        const country = (await response.text()).trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(country)) {
          this.logger.warn(`Invalid country code from ipapi.co: ${country}`);
          return 'UNKNOWN';
        }
        return country;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.warn(
        `Country detection failed for IP ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'UNKNOWN';
    }
  }

  getCurrency(country: string): BillingCurrency {
    return country === 'NG' ? 'NGN' : 'USD';
  }

  normalizeIp(ip?: string | null): string {
    const value = (ip || '127.0.0.1').split(',')[0].trim();
    if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length);
    return value || '127.0.0.1';
  }

  private isPrivateIp(ip: string): boolean {
    return (
      ip === 'localhost' ||
      ip === '127.0.0.1' ||
      ip === '0.0.0.0' ||
      ip === '::1' ||
      ip === '::' ||
      ip.startsWith('10.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
      ip.toLowerCase().startsWith('fc') ||
      ip.toLowerCase().startsWith('fd') ||
      ip.toLowerCase().startsWith('fe80:')
    );
  }
}
