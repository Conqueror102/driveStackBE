import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdatePricingDto {
  @IsString()
  @IsIn(['pro_ngn', 'pro_usd'])
  key: string;

  @IsString()
  @MaxLength(100)
  productId: string;

  @IsInt()
  @Min(0)
  amount: number;

  @IsString()
  @IsIn(['NGN', 'USD'])
  currency: string;

  @IsOptional()
  @IsString()
  @IsIn(['month', 'year'])
  interval?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
