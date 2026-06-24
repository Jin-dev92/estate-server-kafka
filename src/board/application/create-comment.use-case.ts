import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Comment } from '../domain/comment.entity';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  COMMENT_REPOSITORY,
  CommentRepository,
} from '../domain/comment.repository';
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

export interface CreateCommentInput {
  userId: string;
  postId: string;
  content: string;
}

@Injectable()
export class CreateCommentUseCase {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
  ) {}

  async execute(input: CreateCommentInput): Promise<Comment> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    // 도메인 변경 + outbox 적재를 한 트랜잭션으로(유실 창 제거).
    const saved = await this.txRunner.run(async (tx) => {
      const created = await this.comments.create(
        Comment.create({
          postId: input.postId,
          authorId: input.userId,
          content: input.content,
        }),
        tx,
      );
      await this.outbox.add(
        {
          eventId: randomUUID(),
          eventType: EventType.CommentCreated,
          occurredAt: new Date().toISOString(),
          actorId: input.userId,
          entityType: EntityType.Comment,
          entityId: created.id!,
          payload: { postId: created.postId, buildingId: post.buildingId },
        },
        tx,
      );
      return created;
    });

    // 캐시 무효화는 DB 외 작업 → 트랜잭션 커밋 후.
    await this.cache.invalidateDetail(input.postId);
    return saved;
  }
}
