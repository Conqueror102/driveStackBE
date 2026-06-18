import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, ValidateNested } from 'class-validator';

export class BulkFileTargetDto {
  @IsString()
  accountId: string;

  @IsString()
  driveFileId: string;
}

export class BulkFileOperationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkFileTargetDto)
  files: BulkFileTargetDto[];
}
