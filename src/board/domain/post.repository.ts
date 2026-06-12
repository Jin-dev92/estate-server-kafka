import { Post } from './post.entity';

export const POST_REPOSITORY = Symbol('POST_REPOSITORY');

export interface PostRepository {
  create(post: Post): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findByBuilding(buildingId: string): Promise<Post[]>;
  update(post: Post): Promise<Post>;
  delete(id: string): Promise<void>;
}
