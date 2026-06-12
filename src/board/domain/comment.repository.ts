import { Comment } from './comment.entity';

export const COMMENT_REPOSITORY = Symbol('COMMENT_REPOSITORY');

export interface CommentRepository {
  create(comment: Comment): Promise<Comment>;
  findByPost(postId: string): Promise<Comment[]>;
}
