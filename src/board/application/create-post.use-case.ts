import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import { EventType, EntityType } from '../../events/event-type.enum';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { OUTBOX_STORE, OutboxStore } from '../../outbox/domain/outbox-store';

export interface CreatePostInput {
  userId: string;
  buildingId: string;
  category?: PostCategory;
  title: string;
  content: string;
}

@Injectable()
export class CreatePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
  ) {}

  async execute(input: CreatePostInput): Promise<Post> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    const post = Post.create({
      buildingId: input.buildingId,
      authorId: input.userId,
      category: input.category,
      title: input.title,
      content: input.content,
    });

    // 도메인 변경 + outbox 적재를 한 트랜잭션으로(유실 창 제거).
    const saved = await this.txRunner.run(async (tx) => {
      const created = await this.posts.create(post, tx);
      await this.outbox.add(
        {
          eventId: randomUUID(),
          eventType: EventType.PostCreated,
          occurredAt: new Date().toISOString(),
          actorId: input.userId,
          entityType: EntityType.Post,
          entityId: created.id!,
          payload: {
            buildingId: created.buildingId,
            category: created.category,
            title: created.title,
          },
        },
        tx,
      );
      return created;
    });

    // 캐시 무효화는 DB 외 작업 → 트랜잭션 커밋 후.
    await this.cache.invalidateList(input.buildingId);
    return saved;
  }
}
