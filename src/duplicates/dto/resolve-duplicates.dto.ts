import { IsIn, IsOptional, IsString } from 'class-validator';
import type { ResolveStrategy } from '../duplicates.service';

export class ResolveGroupDto {
  @IsString()
  keepFileId: string;
}

export class ResolveAllDto {
  @IsOptional()
  @IsIn(['keep_newest', 'keep_oldest'])
  strategy?: ResolveStrategy;
}
