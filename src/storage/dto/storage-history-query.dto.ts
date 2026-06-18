import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

export class StorageHistoryQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsIn([7, 30, 90])
  days = 30;
}
