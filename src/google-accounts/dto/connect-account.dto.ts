import { IsString } from 'class-validator';

export class ConnectAccountDto {
  @IsString()
  code: string;
}
