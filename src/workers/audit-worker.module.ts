import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { AuditWorkerController } from '../audit/interface/audit-worker.controller';
import { AUDIT_LOG_REPOSITORY } from '../audit/domain/audit-log.repository';
import { PrismaAuditLogRepository } from '../audit/infrastructure/prisma-audit-log.repository';

// audit-worker 프로세스 전용 모듈. chat·board·membership 전체 → AuditLog.
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  controllers: [AuditWorkerController],
  providers: [
    KafkaTopicInitializer,
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
  ],
})
export class AuditWorkerModule {}
