import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ManualUpgradeDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
