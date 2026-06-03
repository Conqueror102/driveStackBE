import { ForbiddenException, Injectable } from '@nestjs/common';
import { Admin, AuditAction, Prisma, UserStatus } from '@prisma/client';
import { AuditService } from '../common/audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ListAdminUsersQueryDto } from './dto/list-admin-users-query.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getSummary() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      verifiedUsers,
      disabledUsers,
      totalAdmins,
      connectedAccounts,
      cachedFiles,
      uploadsByStatus,
      accountsByStatus,
      visits24h,
      visits7d,
      recentRequests,
      topPaths,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { emailVerified: true } }),
      this.prisma.user.count({ where: { status: 'DISABLED' } }),
      this.prisma.admin.count(),
      this.prisma.connectedAccount.count(),
      this.prisma.fileCache.count(),
      this.prisma.uploadSession.groupBy({ by: ['status'], _count: { status: true } }),
      this.prisma.connectedAccount.groupBy({ by: ['status'], _count: { status: true } }),
      this.prisma.requestLog.count({ where: { createdAt: { gte: since24h } } }),
      this.prisma.requestLog.count({ where: { createdAt: { gte: since7d } } }),
      this.prisma.requestLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          method: true,
          path: true,
          statusCode: true,
          durationMs: true,
          createdAt: true,
          userId: true,
          adminId: true,
        },
      }),
      this.prisma.requestLog.groupBy({
        by: ['path'],
        where: { createdAt: { gte: since7d } },
        _count: { path: true },
        orderBy: { _count: { path: 'desc' } },
        take: 10,
      }),
    ]);

    const storage = await this.prisma.connectedAccount.aggregate({
      _sum: { storageLimit: true, storageUsed: true },
    });

    return {
      users: { total: totalUsers, verified: verifiedUsers, disabled: disabledUsers },
      admins: { total: totalAdmins },
      googleAccounts: {
        total: connectedAccounts,
        byStatus: Object.fromEntries(accountsByStatus.map((item) => [item.status, item._count.status])),
      },
      files: { cached: cachedFiles },
      uploads: {
        byStatus: Object.fromEntries(uploadsByStatus.map((item) => [item.status, item._count.status])),
      },
      storage: {
        totalLimit: storage._sum.storageLimit || 0n,
        totalUsed: storage._sum.storageUsed || 0n,
      },
      visits: {
        last24h: visits24h,
        last7d: visits7d,
        topPaths: topPaths.map((item) => ({ path: item.path, count: item._count.path })),
        recent: recentRequests,
      },
    };
  }

  async listUsers(query: ListAdminUsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { displayName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          email: true,
          displayName: true,
          avatarUrl: true,
          emailVerified: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              connectedAccounts: true,
              uploadSessions: true,
            },
          },
        },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        lastPage: Math.ceil(total / query.limit),
      },
    };
  }

  async getUser(userId: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        emailVerified: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        connectedAccounts: {
          select: {
            id: true,
            googleEmail: true,
            displayName: true,
            avatarUrl: true,
            status: true,
            storageLimit: true,
            storageUsed: true,
            quotaUpdatedAt: true,
            lastSyncAt: true,
            lastSyncError: true,
            createdAt: true,
          },
        },
        uploadSessions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            accountId: true,
            fileName: true,
            mimeType: true,
            fileSize: true,
            status: true,
            bytesUploaded: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });
  }

  async updateUserStatus(admin: Admin, userId: string, status: UserStatus) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        status,
        ...(status === 'DISABLED' ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: {
        id: true,
        email: true,
        status: true,
        updatedAt: true,
      },
    });

    await this.audit.log({
      adminId: admin.id,
      userId,
      action: status === 'DISABLED' ? AuditAction.USER_DISABLED : AuditAction.USER_ENABLED,
      metadata: { status },
    });

    return user;
  }

  async listAuditLogs(query: { page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 50, 200);
    const [total, data] = await this.prisma.$transaction([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, email: true } },
          admin: { select: { id: true, email: true, role: true } },
        },
      }),
    ]);
    return { data, meta: { total, page, limit, lastPage: Math.ceil(total / limit) } };
  }

  assertCanChangeUsers(admin: Admin) {
    if (!['ADMIN', 'SUPER_ADMIN'].includes(admin.role)) {
      throw new ForbiddenException('Admin does not have permission');
    }
  }
}
