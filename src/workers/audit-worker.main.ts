import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { AuditWorkerModule } from './audit-worker.module';

// chat·board·membership 전체를 독립 consumer group으로 소비한다(감사).
async function bootstrap() {
  const app = await NestFactory.create(AuditWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'audit-worker' },
    },
  });
  await app.startAllMicroservices();
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
