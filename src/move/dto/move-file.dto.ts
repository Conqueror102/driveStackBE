import { IsString, NotEquals } from 'class-validator';

export class MoveFileDto {
  @IsString()
  driveFileId: string;

  @IsString()
  sourceAccountId: string;

  @IsString()
  @NotEquals('sourceAccountId')
  destinationAccountId: string;
}
