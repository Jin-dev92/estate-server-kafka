import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { NotificationWorkerController } from './interface/notification-worker.controller';
import { HandleEventUseCase } from './application/handle-event.use-case';
import { RECIPIENT_RESOLVER } from './domain/recipient-resolver';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { NOTIFICATION_COUNTER } from './domain/notification-counter';
import { NOTIFICATION_RELAY } from './domain/notification-relay';
import { PrismaRecipientResolver } from './infrastructure/prisma-recipient-resolver';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { RedisNotificationCounter } from './infrastructure/redis-notification-counter';
import { RedisNotificationRelay } from './infrastructure/redis-notification-relay';

// notification-worker 프로세스 전용 모듈. AppModule을 쓰지 않으므로
// 전역 인프라(Config/Prisma/Redis)를 직접 import한다.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
  ],
  controllers: [NotificationWorkerController],
  providers: [
    KafkaTopicInitializer,
    HandleEventUseCase,
    { provide: RECIPIENT_RESOLVER, useClass: PrismaRecipientResolver },
    {
      provide: NOTIFICATION_REPOSITORY,
      useClass: PrismaNotificationRepository,
    },
    { provide: NOTIFICATION_COUNTER, useClass: RedisNotificationCounter },
    { provide: NOTIFICATION_RELAY, useClass: RedisNotificationRelay },
  ],
})
export class NotificationWorkerModule {}
