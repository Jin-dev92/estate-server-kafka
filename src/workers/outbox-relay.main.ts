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
  // running 플래그: 이전 틱이 끝나기 전에 새 틱이 쌓이는 것을 방지한다(틱 누적 방지).
  let running = false;
  setInterval(() => {
    if (running) return; // 이전 틱이 아직 진행 중이면 건너뛴다(틱 누적 방지)
    running = true;
    void relay
      .execute()
      .catch((err: Error) => logger.error(`폴링 틱 실패: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, pollMs);
}

void bootstrap();
