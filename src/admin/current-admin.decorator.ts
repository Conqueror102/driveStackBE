import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Admin } from '@prisma/client';

export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext): Admin => {
  return ctx.switchToHttp().getRequest<{ user: Admin }>().user;
});
