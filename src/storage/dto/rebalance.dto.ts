import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class RebalanceDto {
  // Target max usage percentage for the fullest account after rebalancing.
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(99)
  targetPercent?: number;
}
