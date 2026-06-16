import { RedeemInviteCodeUseCase } from './redeem-invite-code.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { OutboxStore } from '../../outbox/domain/outbox-store';
import { EventType, EntityType } from '../../events/event-type.enum';

const TENANT_ID = 'tenant1';
const UNIT_ID = 'unit1';
// TenantJoined 이벤트 발행 테스트용 상수
const TENANT_ID_EVT = 't1';
const UNIT_ID_EVT = 'unit1';
const LEASE_ID_EVT = 'lease1';
const CODE_EVT = 'ABC123';
const ISSUED_BY = 'owner1';

// 테스트용 더미 TransactionClient
const TX = {} as unknown as TransactionClient;

// txRunner: 콜백을 즉시 실행해 TX를 넘긴다
const txRunner: TransactionRunner = {
  run: (fn) => fn(TX),
};

class FakeInviteStore implements InviteCodeStore {
  issue(): Promise<IssuedInvite> {
    return Promise.resolve({ code: 'x', expiresInSec: 1 });
  }
  redeem(code: string): Promise<InviteCodePayload | null> {
    return Promise.resolve(
      code === 'GOOD' ? { unitId: UNIT_ID, issuedBy: 'owner1' } : null,
    );
  }
}

class CapturingLeaseRepo implements LeaseRepository {
  public saved: Lease | null = null;
  public lastTx: TransactionClient | undefined;
  save(lease: Lease, tx?: TransactionClient): Promise<Lease> {
    this.lastTx = tx;
    this.saved = Lease.reconstitute({
      id: 'lease-generated',
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      status: lease.status,
      endedAt: null,
    });
    return Promise.resolve(this.saved);
  }
  findByTenant(): Promise<Lease[]> {
    return Promise.resolve([]);
  }
  findById(): Promise<Lease | null> {
    return Promise.resolve(null);
  }
  update(lease: Lease): Promise<Lease> {
    return Promise.resolve(lease);
  }
}

// no-op outbox (기존 흐름 검증 테스트용)
const noopOutbox: OutboxStore = {
  add: () => Promise.resolve(),
  fetchPending: () => Promise.resolve([]),
  markPublished: () => Promise.resolve(),
  markFailed: () => Promise.resolve(),
};

/** outbox mock 빌더 */
function makeEventDeps(redeemResult: InviteCodePayload | null) {
  const savedLease = Lease.reconstitute({
    id: LEASE_ID_EVT,
    unitId: UNIT_ID_EVT,
    tenantId: TENANT_ID_EVT,
    status: LeaseStatus.ACTIVE,
    endedAt: null,
  });

  const invites: Partial<InviteCodeStore> = {
    redeem: () => Promise.resolve(redeemResult),
  };

  let saveTx: TransactionClient | undefined;
  const leases: Partial<LeaseRepository> = {
    save: (_lease, tx) => {
      saveTx = tx;
      return Promise.resolve(savedLease);
    },
  };

  const added: unknown[] = [];
  const outbox: OutboxStore = {
    add: (e) => {
      added.push(e);
      return Promise.resolve();
    },
    fetchPending: () => Promise.resolve([]),
    markPublished: () => Promise.resolve(),
    markFailed: () => Promise.resolve(),
  };

  return { invites, leases, outbox, added, getSaveTx: () => saveTx };
}

describe('RedeemInviteCodeUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('유효한 코드면 입주자를 호실에 연결하는 Lease(ACTIVE)를 만든다', async () => {
    const leaseRepo = new CapturingLeaseRepo();
    const useCase = new RedeemInviteCodeUseCase(
      new FakeInviteStore(),
      leaseRepo,
      txRunner,
      noopOutbox,
    );

    const lease = await useCase.execute({ tenantId: TENANT_ID, code: 'GOOD' });

    expect(lease.id).toBe('lease-generated');
    expect(lease.unitId).toBe(UNIT_ID);
    expect(lease.tenantId).toBe(TENANT_ID);
    expect(lease.status).toBe(LeaseStatus.ACTIVE);
    // leases.save가 TX를 받았는지 검증
    expect(leaseRepo.lastTx).toBe(TX);
  });

  it('만료·사용·오타 코드(null)면 NotFoundException', async () => {
    const useCase = new RedeemInviteCodeUseCase(
      new FakeInviteStore(),
      new CapturingLeaseRepo(),
      txRunner,
      noopOutbox,
    );

    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'EXPIRED' }),
    ).rejects.toMatchObject({ code: 'PROPERTY_INVALID_INVITE_CODE' });
  });

  // ── TenantJoined 이벤트 → outbox 적재 ────────────────────────────────────
  it('초대코드 사용 시 TenantJoined를 outbox에 적재한다', async () => {
    // Arrange
    const { invites, leases, outbox, added, getSaveTx } = makeEventDeps({
      unitId: UNIT_ID_EVT,
      issuedBy: ISSUED_BY,
    });
    const useCase = new RedeemInviteCodeUseCase(
      invites as InviteCodeStore,
      leases as LeaseRepository,
      txRunner,
      outbox,
    );

    // Act
    await useCase.execute({ tenantId: TENANT_ID_EVT, code: CODE_EVT });

    // Assert
    expect(added).toEqual([
      expect.objectContaining({
        eventType: EventType.TenantJoined,
        entityType: EntityType.Lease,
        entityId: LEASE_ID_EVT,
        actorId: TENANT_ID_EVT,
        payload: expect.objectContaining({ unitId: UNIT_ID_EVT }) as object,
      }),
    ]);
    // leases.save가 TX를 받았는지 검증
    expect(getSaveTx()).toBe(TX);
  });

  it('유효하지 않은 코드면 적재하지 않는다', async () => {
    // Arrange
    const { invites, leases, outbox, added } = makeEventDeps(null);
    const useCase = new RedeemInviteCodeUseCase(
      invites as InviteCodeStore,
      leases as LeaseRepository,
      txRunner,
      outbox,
    );

    // Act & Assert
    await expect(
      useCase.execute({ tenantId: TENANT_ID_EVT, code: CODE_EVT }),
    ).rejects.toMatchObject({ code: 'PROPERTY_INVALID_INVITE_CODE' });
    expect(added).toEqual([]);
  });
});
