import { FileType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsArray, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class ListFilesQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  // Unified cross-account browsing: filter to a subset of the user's accounts.
  // Accepts `?accountIds=a,b` or repeated `?accountIds=a&accountIds=b`.
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : String(value)
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  accountIds?: string[];

  @IsOptional()
  @IsEnum(FileType)
  fileType?: FileType;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  minSizeBytes?: string;

  @IsOptional()
  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  maxSizeBytes?: string;

  @IsOptional()
  @IsDateString()
  modifiedAfter?: string;

  @IsOptional()
  @IsDateString()
  modifiedBefore?: string;

  @IsOptional()
  @IsIn(['name', 'size', 'modifiedAt'])
  sortBy: 'name' | 'size' | 'modifiedAt' = 'modifiedAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'desc';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}
