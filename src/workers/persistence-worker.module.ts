import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { ChatPersistenceController } from '../chat/infrastructure/chat-persistence.controller';
import { MESSAGE_REPOSITORY } from '../chat/domain/message.repository';
import { PrismaMessageRepository } from '../chat/infrastructure/prisma-message.repository';

// persistence-worker 프로세스 전용 모듈. chat-events → Message 멱등 INSERT.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [ChatPersistenceController],
  providers: [
    KafkaTopicInitializer,
    { provide: MESSAGE_REPOSITORY, useClass: PrismaMessageRepository },
  ],
})
export class PersistenceWorkerModule {}
