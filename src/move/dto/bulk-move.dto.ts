import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, ValidateNested } from 'class-validator';

class BulkMoveFileDto {
  @IsString()
  driveFileId: string;

  @IsString()
  sourceAccountId: string;
}

export class BulkMoveDto {
  @IsString()
  destinationAccountId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BulkMoveFileDto)
  files: BulkMoveFileDto[];
}
