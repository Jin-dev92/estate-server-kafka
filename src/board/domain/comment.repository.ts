import { Comment } from './comment.entity';
import { TransactionClient } from '../../outbox/domain/transaction-runner';

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');

export interface CommentRepository {
  create(comment: Comment, tx?: TransactionClient): Promise<Comment>;
  findByPost(postId: string): Promise<Comment[]>;
}
