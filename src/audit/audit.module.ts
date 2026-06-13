import { Module } from '@nestjs/common';
import { AuditWorkerController } from './interface/audit-worker.controller';
import { AUDIT_LOG_REPOSITORY } from './domain/audit-log.repository';
import { PrismaAuditLogRepository } from './infrastructure/prisma-audit-log.repository';

@Module({
  controllers: [AuditWorkerController],
  providers: [
    { provide: AUDIT_LOG_REPOSITORY, useClass: PrismaAuditLogRepository },
  ],
})
export class AuditModule {}
