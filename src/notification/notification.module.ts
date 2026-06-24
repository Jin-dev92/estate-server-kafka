import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigKey } from '../config/config-keys';
import { NotificationController } from './interface/notification.controller';
import { NotificationGateway } from './interface/notification.gateway';
import { ListNotificationsUseCase } from './application/list-notifications.use-case';
import { GetUnreadCountUseCase } from './application/get-unread-count.use-case';
import { MarkAllReadUseCase } from './application/mark-all-read.use-case';
import { MarkOneReadUseCase } from './application/mark-one-read.use-case';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { NOTIFICATION_COUNTER } from './domain/notification-counter';
import { NOTIFICATION_RELAY } from './domain/notification-relay';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { RedisNotificationCounter } from './infrastructure/redis-notification-counter';
import { RedisNotificationRelay } from './infrastructure/redis-notification-relay';

// main 프로세스: 알림 읽기 HTTP API + WS 푸시 게이트웨이. (컨슈머 없음)
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
      }),
    }),
  ],
  controllers: [NotificationController],
  providers: [
    NotificationGateway,
    ListNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkAllReadUseCase,
    MarkOneReadUseCase,
    {
      provide: NOTIFICATION_REPOSITORY,
      useClass: PrismaNotificationRepository,
    },
    { provide: NOTIFICATION_COUNTER, useClass: RedisNotificationCounter },
    { provide: NOTIFICATION_RELAY, useClass: RedisNotificationRelay },
  ],
})
export class NotificationModule {}
