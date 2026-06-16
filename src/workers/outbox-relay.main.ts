import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ConfigKey } from '../config/config-keys';
import { OutboxModule } from '../outbox/outbox.module';
import { RelayOutboxUseCase } from '../outbox/application/relay-outbox.use-case';

// outbox-relay: PENDING outbox를 주기 폴링해 Kafka로 발행한다(별도 프로세스).
// HTTP/consumer 없는 순수 백그라운드 워커라 application context만 띄운다.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(OutboxModule);
  const logger = new Logger('OutboxRelay');
  const config = app.get(ConfigService);
  const relay = app.get(RelayOutboxUseCase);
  const pollMs = Number(config.get<string>(ConfigKey.OutboxPollMs)) || 1000;

  logger.log(`outbox-relay 시작(폴링 ${pollMs}ms)`);

  // 한 틱 예외가 루프를 죽이지 않도록 보호.
  setInterval(() => {
    void relay.execute().catch((err: Error) => {
      logger.error(`폴링 틱 실패: ${err.message}`);
    });
  }, pollMs);
}

void bootstrap();
