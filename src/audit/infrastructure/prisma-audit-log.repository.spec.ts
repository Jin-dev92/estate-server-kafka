import { Prisma } from '@prisma/client';
import { PrismaAuditLogRepository } from './prisma-audit-log.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainEvent } from '../../events/domain-event';
import { EventType, EntityType } from '../../events/event-type.enum';

const event: DomainEvent = {
  eventId: 'e1',
  eventType: EventType.PostCreated,
  occurredAt: '2026-06-14T00:00:00.000Z',
  actorId: 'u1',
  entityType: EntityType.Post,
  entityId: 'p1',
  payload: { buildingId: 'b1' },
};

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('PrismaAuditLogRepository', () => {
  let prisma: { auditLog: { create: jest.Mock } };
  let repo: PrismaAuditLogRepository;

  beforeEach(() => {
    // PrismaService 부분 mock (테스트 한정 as unknown as).
    prisma = { auditLog: { create: jest.fn() } };
    repo = new PrismaAuditLogRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.clearAllMocks());

  it('이벤트를 AuditLog로 적재한다', async () => {
    prisma.auditLog.create.mockResolvedValue({});

    await repo.record(event);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        eventId: 'e1',
        eventType: EventType.PostCreated,
        actorId: 'u1',
        entityType: EntityType.Post,
        entityId: 'p1',
        payload: { buildingId: 'b1' },
        occurredAt: new Date('2026-06-14T00:00:00.000Z'),
      },
    });
  });

  it('중복 eventId(P2002)는 throw하지 않고 무시한다(멱등)', async () => {
    prisma.auditLog.create.mockRejectedValue(p2002());

    await expect(repo.record(event)).resolves.toBeUndefined();
  });

  it('그 외 에러는 다시 던진다(Kafka 재시도 유도)', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));

    await expect(repo.record(event)).rejects.toThrow('db down');
  });
});
