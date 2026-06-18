import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSavedSearchDto, UpdateSavedSearchDto } from './dto/saved-search.dto';

@Injectable()
export class SavedSearchesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.savedSearch.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, dto: CreateSavedSearchDto) {
    await this.assertAccountScope(userId, dto.accountId);
    return this.prisma.savedSearch.create({
      data: this.toData(userId, dto),
    });
  }

  async update(userId: string, savedSearchId: string, dto: UpdateSavedSearchDto) {
    const existing = await this.prisma.savedSearch.findUnique({ where: { id: savedSearchId } });
    if (!existing) {
      throw new NotFoundException('Saved search not found');
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException('Saved search does not belong to user');
    }
    await this.assertAccountScope(userId, dto.accountId);
    return this.prisma.savedSearch.update({
      where: { id: savedSearchId },
      data: this.toData(userId, dto),
    });
  }

  async remove(userId: string, savedSearchId: string) {
    const existing = await this.prisma.savedSearch.findUnique({ where: { id: savedSearchId } });
    if (!existing) {
      throw new NotFoundException('Saved search not found');
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException('Saved search does not belong to user');
    }
    await this.prisma.savedSearch.delete({ where: { id: savedSearchId } });
    return { success: true };
  }

  private async assertAccountScope(userId: string, accountId?: string): Promise<void> {
    if (!accountId) return;
    const account = await this.prisma.connectedAccount.findFirst({ where: { id: accountId, userId }, select: { id: true } });
    if (!account) {
      throw new ForbiddenException('Account does not belong to user');
    }
  }

  private toData(userId: string, dto: CreateSavedSearchDto | UpdateSavedSearchDto) {
    return {
      userId,
      name: dto.name,
      search: dto.search,
      accountId: dto.accountId,
      fileType: dto.fileType,
      minSizeBytes: dto.minSizeBytes ? BigInt(dto.minSizeBytes) : null,
      maxSizeBytes: dto.maxSizeBytes ? BigInt(dto.maxSizeBytes) : null,
      modifiedAfter: dto.modifiedAfter ? new Date(dto.modifiedAfter) : null,
      modifiedBefore: dto.modifiedBefore ? new Date(dto.modifiedBefore) : null,
      sortBy: dto.sortBy,
      sortOrder: dto.sortOrder,
    };
  }
}
