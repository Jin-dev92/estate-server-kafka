import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConfigKey } from '../../config/config-keys';
import { TokenPayload } from '../../auth/domain/token-issuer';
import {
  NOTIFICATION_RELAY,
  NotificationRelay,
} from '../domain/notification-relay';

// 알림 전용 WS. 채팅과 namespace를 분리(/notifications)해 핸들러 간섭을 막는다.
// 워커가 Redis로 발행한 알림을 받아 접속 중인 수신자에게만 emit한다.
@WebSocketGateway({ namespace: 'notifications', cors: true })
export class NotificationGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(NotificationGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_RELAY) private readonly relay: NotificationRelay,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('알림 게이트웨이 구독 시작');
    await this.relay.subscribe((payload) => {
      this.server
        .to(`user:${payload.recipientId}`)
        .emit('notification', payload.notification);
    });
  }

  // 핸드셰이크 JWT 검증 후 사용자 전용 룸에 join. 실패 시 연결 거부.
  handleConnection(client: Socket): void {
    try {
      const token = (client.handshake.auth?.token ?? '') as string;
      const payload = this.jwt.verify<TokenPayload>(token, {
        secret: this.config.getOrThrow<string>(ConfigKey.JwtSecret),
      });
      (client.data as { userId?: string }).userId = payload.sub;
      void client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }
}
