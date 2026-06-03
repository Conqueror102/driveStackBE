import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(input: {
    userId?: string;
    adminId?: string;
    action: AuditAction;
    accountId?: string;
    resourceId?: string;
    metadata?: Prisma.InputJsonValue;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId,
        adminId: input.adminId,
        action: input.action,
        accountId: input.accountId,
        resourceId: input.resourceId,
        metadata: input.metadata,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }
}
