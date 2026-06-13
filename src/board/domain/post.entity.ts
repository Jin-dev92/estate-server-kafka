import { PostCategory } from './post-category.enum';
import { DomainError } from '../../common/errors/domain-error';

interface PostProps {
  id: string | null;
  buildingId: string;
  authorId: string;
  category: PostCategory;
  title: string;
  content: string;
}

export class Post {
  private constructor(private readonly props: PostProps) {}

  static create(input: {
    buildingId: string;
    authorId: string;
    category?: PostCategory;
    title: string;
    content: string;
  }): Post {
    if (!input.buildingId) throw new DomainError('건물 ID는 필수입니다.');
    if (!input.authorId) throw new DomainError('작성자 ID는 필수입니다.');
    if (!input.title) throw new DomainError('제목은 필수입니다.');
    if (!input.content) throw new DomainError('본문은 필수입니다.');
    return new Post({
      id: null,
      buildingId: input.buildingId,
      authorId: input.authorId,
      category: input.category ?? PostCategory.FREE,
      title: input.title,
      content: input.content,
    });
  }

  static reconstitute(props: PostProps): Post {
    return new Post(props);
  }

  edit(input: { title: string; content: string }): Post {
    if (!input.title) throw new DomainError('제목은 필수입니다.');
    if (!input.content) throw new DomainError('본문은 필수입니다.');
    return new Post({
      ...this.props,
      title: input.title,
      content: input.content,
    });
  }

  isAuthoredBy(userId: string): boolean {
    return this.props.authorId === userId;
  }

  get id(): string | null {
    return this.props.id;
  }
  get buildingId(): string {
    return this.props.buildingId;
  }
  get authorId(): string {
    return this.props.authorId;
  }
  get category(): PostCategory {
    return this.props.category;
  }
  get title(): string {
    return this.props.title;
  }
  get content(): string {
    return this.props.content;
  }
}
