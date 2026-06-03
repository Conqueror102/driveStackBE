import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateUploadSessionDto {
  @IsString()
  accountId: string;

  @IsString()
  fileName: string;

  @IsString()
  mimeType: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  fileSize: number;

  @IsOptional()
  @IsString()
  parentId?: string;
}
