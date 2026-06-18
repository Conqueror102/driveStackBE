import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class StorageSummaryQueryDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  fileSize?: number;
}
