import { CreateCommentUseCase } from './create-comment.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { Comment } from '../domain/comment.entity';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { BoardCache } from './board-cache';
import { MembershipChecker } from './membership';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { OutboxStore } from '../../outbox/domain/outbox-store';
import { EventType, EntityType } from '../../events/event-type.enum';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

// 테스트용 더미 TransactionClient
const TX = {} as unknown as TransactionClient;

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

// comments.create가 tx를 받는지 검증하기 위해 spy 포함
function makeCommentRepo() {
  let lastTx: TransactionClient | undefined;
  const commentRepo: CommentRepository = {
    create: (c, tx) => {
      lastTx = tx;
      return Promise.resolve(
        Comment.reconstitute({
          id: 'c-generated',
          postId: c.postId,
          authorId: c.authorId,
          content: c.content,
        }),
      );
    },
    findByPost: () => Promise.resolve([]),
  };
  return { commentRepo, getLastTx: () => lastTx };
}

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: 'author',
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

// txRunner: 콜백을 즉시 실행해 TX를 넘긴다
const txRunner: TransactionRunner = {
  run: (fn) => fn(TX),
};

describe('CreateCommentUseCase', () => {
  it('멤버가 댓글을 달면 저장하고 상세 캐시를 무효화하며 outbox에 적재한다', async () => {
    const cache = new SpyCache();
    const { commentRepo, getLastTx } = makeCommentRepo();
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

    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      cache,
      membershipReturning(true),
      txRunner,
      outbox,
    );

    const comment = await useCase.execute({
      userId: USER_ID,
      postId: POST_ID,
      content: '댓글',
    });

    expect(comment.id).toBe('c-generated');
    expect(cache.invalidatedDetail).toBe(POST_ID);

    // outbox 적재 검증
    expect(added).toEqual([
      expect.objectContaining({
        eventType: EventType.CommentCreated,
        entityType: EntityType.Comment,
        entityId: 'c-generated',
        actorId: USER_ID,
        payload: expect.objectContaining({ postId: POST_ID }) as object,
      }),
    ]);
    // repo.create가 TX를 받았는지 검증
    expect(getLastTx()).toBe(TX);
  });

  it('없는 글이면 NotFoundException', async () => {
    const { commentRepo } = makeCommentRepo();
    const outbox: OutboxStore = {
      add: () => Promise.resolve(),
      fetchPending: () => Promise.resolve([]),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
    };

    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(null),
      new SpyCache(),
      membershipReturning(true),
      txRunner,
      outbox,
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const { commentRepo } = makeCommentRepo();
    const outbox: OutboxStore = {
      add: () => Promise.resolve(),
      fetchPending: () => Promise.resolve([]),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
    };

    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      new SpyCache(),
      membershipReturning(false),
      txRunner,
      outbox,
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });
});
