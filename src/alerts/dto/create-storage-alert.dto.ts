import { IsIn, IsString } from 'class-validator';

export class CreateStorageAlertDto {
  @IsString()
  accountId: string;

  @IsIn([80, 90])
  threshold: 80 | 90;
}
