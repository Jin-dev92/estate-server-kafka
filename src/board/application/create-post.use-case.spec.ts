import { CreatePostUseCase } from './create-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';
import { MembershipChecker } from './membership';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { OutboxStore } from '../../outbox/domain/outbox-store';
import { EventType, EntityType } from '../../events/event-type.enum';

const USER_ID = 'u1';
const BUILDING_ID = 'b1';
const POST_ID = 'p1';

// 테스트용 더미 TransactionClient (타입만 맞추면 됨)
const TX = {} as unknown as TransactionClient;

function deps(isMember: boolean) {
  const saved = Post.reconstitute({
    id: POST_ID,
    buildingId: BUILDING_ID,
    authorId: USER_ID,
    category: PostCategory.FREE,
    title: '제목',
    content: '본문',
  });

  // create가 tx를 두 번째 인자로 받는지 검증하기 위해 spy 형태로 정의
  let lastTx: TransactionClient | undefined;
  const posts: PostRepository = {
    create: (_p, tx) => {
      lastTx = tx;
      return Promise.resolve(saved);
    },
    findById: () => Promise.resolve(null),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
  const cache: Partial<BoardCache> = {
    invalidateList: () => Promise.resolve(),
  };
  const membership: MembershipChecker = {
    isMember: () => Promise.resolve(isMember),
  };

  // txRunner: 콜백을 즉시 실행해 TX를 넘긴다
  const txRunner: TransactionRunner = {
    run: (fn) => fn(TX),
  };

  // outbox: add 호출을 캡처한다
  const added: unknown[] = [];
  const outbox: OutboxStore = {
    add: (e) => {
      added.push(e);
      return Promise.resolve();
    },
    fetchPending: () => Promise.resolve([]),
    markPublished: () => Promise.resolve(),
    markFailed: () => Promise.resolve({ quarantined: false }),
  };

  return {
    posts,
    cache,
    membership,
    txRunner,
    outbox,
    added,
    getLastTx: () => lastTx,
  };
}

describe('CreatePostUseCase', () => {
  it('멤버가 작성하면 PostCreated 이벤트를 outbox에 적재한다', async () => {
    const { posts, cache, membership, txRunner, outbox, added, getLastTx } =
      deps(true);
    const useCase = new CreatePostUseCase(
      posts,
      cache as BoardCache,
      membership,
      txRunner,
      outbox,
    );

    await useCase.execute({
      userId: USER_ID,
      buildingId: BUILDING_ID,
      title: '제목',
      content: '본문',
    });

    // outbox에 적재된 이벤트 검증
    expect(added).toEqual([
      expect.objectContaining({
        eventType: EventType.PostCreated,
        entityType: EntityType.Post,
        entityId: POST_ID,
        actorId: USER_ID,
        payload: expect.objectContaining({ buildingId: BUILDING_ID }) as object,
      }),
    ]);
    // repo.create가 TX를 받았는지 검증
    expect(getLastTx()).toBe(TX);
  });

  it('멤버가 아니면 NOT_BUILDING_MEMBER로 거부하고 적재하지 않는다', async () => {
    const { posts, cache, membership, txRunner, outbox, added } = deps(false);
    const useCase = new CreatePostUseCase(
      posts,
      cache as BoardCache,
      membership,
      txRunner,
      outbox,
    );

    await expect(
      useCase.execute({
        userId: USER_ID,
        buildingId: BUILDING_ID,
        title: 't',
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
    expect(added).toEqual([]);
  });
});
