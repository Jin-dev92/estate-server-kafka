import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache, PostSummary } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';

export interface ListPostsInput {
  userId: string;
  buildingId: string;
}

@Injectable()
export class ListPostsUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: ListPostsInput): Promise<PostSummary[]> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new ForbiddenException('not a building member');

    const cached = await this.cache.getList(input.buildingId);
    if (cached) return cached;

    const posts = await this.posts.findByBuilding(input.buildingId);
    const summaries: PostSummary[] = posts.map((p) => ({
      id: p.id!,
      category: p.category,
      title: p.title,
      authorId: p.authorId,
    }));
    await this.cache.setList(input.buildingId, summaries);
    return summaries;
  }
}
