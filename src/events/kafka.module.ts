import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigKey } from '../config/config-keys';
import { EVENT_PUBLISHER } from './event-publisher';
import { KafkaEventPublisher, KAFKA_CLIENT } from './kafka-event.publisher';

// 전역 모듈: 어느 컨텍스트의 유스케이스든 EVENT_PUBLISHER를 주입받을 수 있다.
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: KAFKA_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.KAFKA,
          options: {
            client: {
              brokers: config
                .getOrThrow<string>(ConfigKey.KafkaBrokers)
                .split(','),
            },
          },
        }),
      },
    ]),
  ],
  providers: [{ provide: EVENT_PUBLISHER, useClass: KafkaEventPublisher }],
  exports: [EVENT_PUBLISHER],
})
export class KafkaModule {}
