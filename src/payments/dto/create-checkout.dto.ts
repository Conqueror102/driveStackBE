import { IsBoolean, IsOptional } from 'class-validator';

export class CreateCheckoutDto {
  @IsOptional()
  @IsBoolean()
  isAnnual?: boolean;
}
