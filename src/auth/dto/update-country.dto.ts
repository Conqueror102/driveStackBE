import { IsIn, IsString, Length } from 'class-validator';

export class UpdateCountryDto {
  @IsString()
  @Length(2, 2)
  @IsIn(['NG', 'US', 'GB', 'CA', 'AU', 'GH', 'KE', 'ZA'])
  country: string;
}
