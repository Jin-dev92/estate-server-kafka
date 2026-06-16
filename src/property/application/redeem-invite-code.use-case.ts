import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { PropertyError } from '../property.errors';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
} from '../domain/invite-code.store';
import { EntityType, EventType } from '../../events/event-type.enum';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { OUTBOX_STORE, OutboxStore } from '../../outbox/domain/outbox-store';

export interface RedeemInviteCodeInput {
  tenantId: string;
  code: string;
}

@Injectable()
export class RedeemInviteCodeUseCase {
  constructor(
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
  ) {}

  async execute(input: RedeemInviteCodeInput): Promise<Lease> {
    // 초대코드는 Redis에서 소비(외부 시스템) → 트랜잭션 외부에서 실행.
    // 주의: DB tx 롤백 시 이미 소비된 코드가 복구되지 않음(Redis↔DB 정합성은
    //   Outbox 범위 외 관심사 — 기존 동작 유지).
    const payload = await this.invites.redeem(input.code);
    if (!payload) {
      // 만료/이미 사용/존재하지 않음을 구분하지 않는다(코드 존재 여부 미누설)
      throw new AppException(PropertyError.INVALID_INVITE_CODE);
    }
    const lease = Lease.create({
      unitId: payload.unitId,
      tenantId: input.tenantId,
    });

    // 도메인 변경 + outbox 적재를 한 트랜잭션으로(유실 창 제거).
    return this.txRunner.run(async (tx) => {
      const saved = await this.leases.save(lease, tx);
      await this.outbox.add(
        {
          eventId: randomUUID(),
          eventType: EventType.TenantJoined,
          occurredAt: new Date().toISOString(),
          actorId: input.tenantId,
          entityType: EntityType.Lease,
          entityId: saved.id!,
          payload: { unitId: saved.unitId },
        },
        tx,
      );
      return saved;
    });
  }
}
