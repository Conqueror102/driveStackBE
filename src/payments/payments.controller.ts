import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { SafeUser } from '../auth/auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { GeoService } from '../common/geo/geo.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';
import { PaymentsService } from './payments.service';

@UseGuards(JwtAuthGuard)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly geo: GeoService,
  ) {}

  @Post('checkout')
  createCheckout(@Body() _dto: CreateCheckoutDto, @CurrentUser() user: SafeUser, @Req() req: Request) {
    return this.payments.createCheckoutSession(user.id, this.geo.normalizeIp(req.ip || req.socket.remoteAddress));
  }

  @Post('cancel')
  cancel(@CurrentUser() user: SafeUser) {
    return this.payments.cancelSubscription(user.id);
  }

  @Get('portal')
  portal(@CurrentUser() user: SafeUser) {
    return this.payments.getCustomerPortalUrl(user.id);
  }

  @Get('status')
  status(@CurrentUser() user: SafeUser) {
    return this.subscriptions.getStatus(user.id);
  }
}
