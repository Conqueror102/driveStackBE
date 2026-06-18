import { MovePhase, MoveStatus } from '@prisma/client';

export type MoveStatusPayload = {
  operationId: string;
  status: MoveStatus;
  phase?: MovePhase;
  fileName: string;
  bytesTransferred?: string;
  totalBytes?: string;
  progress?: number;
  totalItems?: number;
  completedItems?: number;
  destinationAccountId?: string;
  error?: string;
};
