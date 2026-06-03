import { Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class BigIntJsonPipe implements PipeTransform {
  transform(value: unknown) {
    return value;
  }
}
