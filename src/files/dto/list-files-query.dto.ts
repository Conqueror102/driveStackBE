import { FileType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListFilesQueryDto {
  @IsOptional()
  @IsString()
  accountId?: string;

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
