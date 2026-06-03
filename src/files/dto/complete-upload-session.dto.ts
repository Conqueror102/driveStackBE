import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

export class CompleteUploadSessionDto {
  @IsString()
  driveFileId: string;

  @Transform(({ value }) => String(value))
  @Matches(/^\d+$/)
  bytesUploaded: string;
}
