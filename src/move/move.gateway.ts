import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { MoveStatusPayload } from './move.types';

type JwtPayload = {
  sub: string;
  email: string;
  tokenVersion?: number;
};

@WebSocketGateway({
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3001', credentials: true },
  namespace: '/move',
})
export class MoveGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @SubscribeMessage('join-operation')
  async handleJoin(
    @MessageBody() data: { operationId?: string; token?: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (!data.operationId) {
      throw new WsException('operationId is required');
    }
    const userId = await this.authenticate(client, data.token);
    const operation = await this.prisma.moveOperation.findFirst({
      where: { id: data.operationId, userId },
      select: { id: true },
    });
    if (!operation) {
      throw new WsException('Move operation not found');
    }
    await client.join(`move:${data.operationId}`);
    return { joined: true, operationId: data.operationId };
  }

  emitStatus(operationId: string, payload: MoveStatusPayload) {
    this.server.to(`move:${operationId}`).emit('move-status', payload);
  }

  private async authenticate(client: Socket, tokenFromBody?: string): Promise<string> {
    const authHeader = client.handshake.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    const token = tokenFromBody || bearerToken || client.handshake.auth?.token;
    if (!token || typeof token !== 'string') {
      throw new WsException('Authentication token is required');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== (payload.tokenVersion || 0)) {
        throw new WsException('Invalid token');
      }
      return user.id;
    } catch {
      throw new WsException('Invalid token');
    }
  }
}
