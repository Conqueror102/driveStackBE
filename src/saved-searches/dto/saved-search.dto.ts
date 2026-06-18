import { FileType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateSavedSearchDto {
  @IsString()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsEnum(FileType)
  fileType?: FileType;

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
}

export class UpdateSavedSearchDto extends CreateSavedSearchDto {}
