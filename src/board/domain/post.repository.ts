import { Post } from './post.entity';
import { TransactionClient } from '../../outbox/domain/transaction-runner';

export const POST_REPOSITORY = Symbol('POST_REPOSITORY');

export interface PostRepository {
  create(post: Post, tx?: TransactionClient): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findByBuilding(buildingId: string): Promise<Post[]>;
  update(post: Post): Promise<Post>;
  delete(id: string): Promise<void>;
}
