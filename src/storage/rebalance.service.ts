import { BadRequestException, Injectable } from '@nestjs/common';
import { ConnectedAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureGuardService } from '../subscriptions/feature-guard.service';
import { MoveService } from '../move/move.service';

const DEFAULT_TARGET_PERCENT = 80;

export type RebalancePlanFile = {
  fileId: string;
  driveFileId: string;
  name: string;
  sizeBytes: bigint;
};

export type RebalancePlan = {
  possible: boolean;
  reason?: string;
  sourceAccountId?: string;
  sourceEmail?: string;
  destinationAccountId?: string;
  destinationEmail?: string;
  bytesToFree: bigint;
  bytesMoved: bigint;
  projectedSourceUsed?: bigint;
  projectedDestinationUsed?: bigint;
  files: RebalancePlanFile[];
};

/**
 * Smart storage rebalancing: move the largest files off the fullest account
 * onto the account with the most free space, reusing the existing move engine
 * (MoveService) so all transfers get live progress via the move gateway.
 */
@Injectable()
export class RebalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureGuard: FeatureGuardService,
    private readonly moveService: MoveService,
  ) {}

  async plan(userId: string, targetPercent = DEFAULT_TARGET_PERCENT): Promise<RebalancePlan> {
    await this.featureGuard.requireFeature(userId, 'move_files');
    return this.buildPlan(userId, targetPercent);
  }

  async execute(userId: string, targetPercent = DEFAULT_TARGET_PERCENT) {
    await this.featureGuard.requireFeature(userId, 'move_files');
    // Recompute server-side — never trust a client-supplied plan.
    const plan = await this.buildPlan(userId, targetPercent);
    if (!plan.possible || !plan.sourceAccountId || !plan.destinationAccountId) {
      throw new BadRequestException(plan.reason || 'Nothing to rebalance');
    }

    const operationIds: string[] = [];
    for (const file of plan.files) {
      const { operationId } = await this.moveService.initiate(userId, {
        driveFileId: file.driveFileId,
        sourceAccountId: plan.sourceAccountId,
        destinationAccountId: plan.destinationAccountId,
      });
      operationIds.push(operationId);
    }

    return {
      sourceAccountId: plan.sourceAccountId,
      destinationAccountId: plan.destinationAccountId,
      filesQueued: plan.files.length,
      bytesMoved: plan.bytesMoved,
      operationIds,
    };
  }

  private async buildPlan(userId: string, targetPercent: number): Promise<RebalancePlan> {
    if (targetPercent < 1 || targetPercent > 99) {
      throw new BadRequestException('targetPercent must be between 1 and 99');
    }
    const accounts = await this.prisma.connectedAccount.findMany({ where: { userId } });
    const empty: RebalancePlan = { possible: false, bytesToFree: 0n, bytesMoved: 0n, files: [] };

    const usable = accounts.filter((a) => a.status !== 'REAUTH_REQUIRED' && a.storageLimit > 0n);
    if (usable.length < 2) {
      return { ...empty, reason: 'Need at least two healthy accounts to rebalance.' };
    }

    // Fullest account by usage ratio.
    const source = [...usable].sort((a, b) => this.ratio(b) - this.ratio(a))[0];
    const bytesToFree = source.storageUsed - (source.storageLimit * BigInt(targetPercent)) / 100n;
    if (bytesToFree <= 0n) {
      return { ...empty, reason: 'No account is over the target threshold.' };
    }

    // Destination = most free space among the others.
    const destination = usable
      .filter((a) => a.id !== source.id)
      .sort((a, b) => this.compareBigint(this.free(b), this.free(a)))[0];
    if (!destination || this.free(destination) <= 0n) {
      return { ...empty, reason: 'No destination account has free space.' };
    }

    // Largest movable files on the source, biggest first.
    const candidates = await this.prisma.fileCache.findMany({
      where: { accountId: source.id, isFolder: false, sizeBytes: { gt: 0 } },
      select: { id: true, driveFileId: true, name: true, sizeBytes: true },
      orderBy: { sizeBytes: 'desc' },
      take: 500,
    });

    const files: RebalancePlanFile[] = [];
    let bytesMoved = 0n;
    let destinationFree = this.free(destination);
    for (const file of candidates) {
      if (bytesMoved >= bytesToFree) break;
      if (file.sizeBytes > destinationFree) continue; // won't fit; skip to a smaller one
      files.push({
        fileId: file.id,
        driveFileId: file.driveFileId,
        name: file.name,
        sizeBytes: file.sizeBytes,
      });
      bytesMoved += file.sizeBytes;
      destinationFree -= file.sizeBytes;
    }

    if (files.length === 0) {
      return { ...empty, reason: 'No files fit the destination account’s free space.' };
    }

    return {
      possible: true,
      sourceAccountId: source.id,
      sourceEmail: source.googleEmail,
      destinationAccountId: destination.id,
      destinationEmail: destination.googleEmail,
      bytesToFree,
      bytesMoved,
      projectedSourceUsed: source.storageUsed - bytesMoved,
      projectedDestinationUsed: destination.storageUsed + bytesMoved,
      files,
    };
  }

  private ratio(account: ConnectedAccount): number {
    if (account.storageLimit <= 0n) return 0;
    return Number(account.storageUsed) / Number(account.storageLimit);
  }

  private free(account: ConnectedAccount): bigint {
    return account.storageLimit - account.storageUsed;
  }

  private compareBigint(a: bigint, b: bigint): number {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
}
