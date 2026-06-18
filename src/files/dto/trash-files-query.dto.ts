import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class TrashFilesQueryDto {
  @IsNotEmpty()
  @IsString()
  accountId: string;

  @IsOptional()
  @IsString()
  pageToken?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 50;
}
