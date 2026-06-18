import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class LargeFilesQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  minSizeBytes?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;
}
