import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import {
  AUDIT_LOG_REPOSITORY,
  AuditLogRepository,
} from '../domain/audit-log.repository';

// audit-worker: board-events·membership-events를 구독해 AuditLog로 적재한다.
// 부작용 없는 첫 소비자(persistence는 M4, notification은 M5).
@Controller()
export class AuditWorkerController {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly audit: AuditLogRepository,
  ) {}

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.audit.record(event);
  }

  @EventPattern(KafkaTopic.MembershipEvents)
  async onMembershipEvent(@Payload() event: DomainEvent): Promise<void> {
    await this.audit.record(event);
  }
}
