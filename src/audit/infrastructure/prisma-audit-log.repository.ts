import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditLogRepository } from '../domain/audit-log.repository';
import { DomainEvent } from '../../events/domain-event';

@Injectable()
export class PrismaAuditLogRepository implements AuditLogRepository {
  private readonly logger = new Logger(PrismaAuditLogRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: DomainEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          eventId: event.eventId,
          eventType: event.eventType,
          actorId: event.actorId,
          entityType: event.entityType,
          entityId: event.entityId,
          payload: event.payload as Prisma.InputJsonValue,
          occurredAt: new Date(event.occurredAt),
        },
      });
    } catch (err) {
      // at-least-once라 같은 이벤트가 또 올 수 있다. eventId @unique 충돌(P2002)은
      // "이미 적재됨"이므로 멱등하게 무시한다. 그 외 오류는 재시도되도록 다시 던진다.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        this.logger.warn(`중복 이벤트 무시: ${event.eventId}`);
        return;
      }
      throw err;
    }
  }
}
