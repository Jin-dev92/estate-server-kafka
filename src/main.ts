import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { ConfigKey } from './config/config-keys';
import { KafkaTopicInitializer } from './events/kafka-topic-initializer';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // consumer 시작 전에 토픽을 명시적으로 생성한다(B 방식, auto-create off).
  // startAllMicroservices()보다 먼저 await해 audit-worker 구독 시점에
  // 토픽이 반드시 존재하도록 보장한다(콜드스타트 race 제거).
  await app.get(KafkaTopicInitializer).ensureTopics();

  // audit-worker(Kafka consumer)를 같은 프로세스에 띄운다(hybrid app).
  const config = app.get(ConfigService);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'audit-worker' },
    },
  });

  // 프로덕션에서는 전체 API 표면을 인증 없이 노출하지 않도록 /docs 를 끈다.
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    setupSwagger(app);
  }

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
