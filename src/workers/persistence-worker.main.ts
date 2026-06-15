import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { PersistenceWorkerModule } from './persistence-worker.module';

// chat-events를 독립 consumer group으로 소비한다(영속화).
async function bootstrap() {
  const app = await NestFactory.create(PersistenceWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'persistence-worker' },
    },
  });
  await app.startAllMicroservices();
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
