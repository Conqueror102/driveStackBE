import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class UploadFromUrlDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url: string;

  @IsString()
  accountId: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
