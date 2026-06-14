import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';
import { ConfigKey } from '../config/config-keys';
import { KAFKA_TOPIC_SPECS } from './kafka-topics.config';

// 부팅 시 필요한 토픽을 명시적으로 생성한다(B 방식).
// main.ts에서 startAllMicroservices()(=consumer 시작) "전"에 ensureTopics()를
// 명시적으로 await하므로, audit-worker가 구독을 시작할 때 토픽이 이미 존재한다
// → 콜드스타트 race("This server does not host this topic-partition") 제거.
// (라이프사이클 훅의 호출 순서에 의존하지 않고 결정론적으로 보장한다.)
@Injectable()
export class KafkaTopicInitializer {
  private readonly logger = new Logger(KafkaTopicInitializer.name);

  constructor(private readonly config: ConfigService) {}

  async ensureTopics(): Promise<void> {
    const brokers = this.config
      .getOrThrow<string>(ConfigKey.KafkaBrokers)
      .split(',');
    const admin = new Kafka({ brokers }).admin();
    await admin.connect();
    try {
      // 이미 존재하는 토픽을 createTopics에 넘기면 브로커가 에러를 내므로,
      // 현재 토픽 목록과의 차집합(신규)만 생성한다(멱등 + 깔끔한 로그).
      const existing = new Set(await admin.listTopics());
      const toCreate = KAFKA_TOPIC_SPECS.filter(
        (spec) => !existing.has(spec.topic),
      );
      if (toCreate.length === 0) {
        this.logger.log('토픽이 모두 존재함(생성 건너뜀)');
        return;
      }
      await admin.createTopics({
        waitForLeaders: true,
        topics: toCreate.map((spec) => ({
          topic: spec.topic,
          numPartitions: spec.numPartitions,
          replicationFactor: spec.replicationFactor,
        })),
      });
      this.logger.log(
        `토픽 생성 완료: ${toCreate.map((s) => s.topic).join(', ')}`,
      );
    } finally {
      await admin.disconnect();
    }
  }
}
