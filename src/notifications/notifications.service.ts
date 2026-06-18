import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, readFilter: 'all' | 'read' | 'unread' = 'unread') {
    const where = { userId } as { userId: string; read?: boolean };
    if (readFilter === 'read') {
      Object.assign(where, { read: true });
    }
    if (readFilter === 'unread') {
      Object.assign(where, { read: false });
    }

    return this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async count(userId: string) {
    const [unread, total] = await Promise.all([
      this.prisma.notification.count({ where: { userId, read: false } }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { unread, total };
  }

  async create(userId: string, type: NotificationType, message: string) {
    return this.prisma.notification.create({
      data: { userId, type, message },
    });
  }

  async markRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    if (notification.userId !== userId) {
      throw new ForbiddenException('Notification does not belong to user');
    }
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    return { updated: result.count };
  }
}
