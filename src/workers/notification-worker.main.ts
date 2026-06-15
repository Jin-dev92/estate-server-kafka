import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { NotificationWorkerModule } from '../notification/notification-worker.module';

// chat·board 이벤트를 독립 consumer group으로 소비한다(알림 생성·푸시).
async function bootstrap() {
  const app = await NestFactory.create(NotificationWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'notification-worker' },
    },
  });
  await app.startAllMicroservices();
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
