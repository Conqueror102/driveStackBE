import { Injectable } from '@nestjs/common';
import { ActivityEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListActivityQueryDto } from './dto/list-activity-query.dto';

export type CreateActivityInput = {
  userId: string;
  type: ActivityEventType;
  message: string;
  accountId?: string;
  fileId?: string;
  operationId?: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateActivityInput) {
    return this.prisma.activityEvent.create({
      data: {
        userId: input.userId,
        type: input.type,
        message: input.message,
        accountId: input.accountId,
        fileId: input.fileId,
        operationId: input.operationId,
        metadata: input.metadata,
      },
    });
  }

  async list(userId: string, query: ListActivityQueryDto) {
    const where = {
      userId,
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, data] = await this.prisma.$transaction([
      this.prisma.activityEvent.count({ where }),
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
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

  recent(userId: string) {
    return this.prisma.activityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }
}
