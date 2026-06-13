import { DomainError } from '../../common/errors/domain-error';

interface CommentProps {
  id: string | null;
  postId: string;
  authorId: string;
  content: string;
}

export class Comment {
  private constructor(private readonly props: CommentProps) {}

  static create(input: {
    postId: string;
    authorId: string;
    content: string;
  }): Comment {
    if (!input.postId) throw new DomainError('게시글 ID는 필수입니다.');
    if (!input.authorId) throw new DomainError('작성자 ID는 필수입니다.');
    if (!input.content) throw new DomainError('내용은 필수입니다.');
    return new Comment({
      id: null,
      postId: input.postId,
      authorId: input.authorId,
      content: input.content,
    });
  }

  static reconstitute(props: CommentProps): Comment {
    return new Comment(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get postId(): string {
    return this.props.postId;
  }
  get authorId(): string {
    return this.props.authorId;
  }
  get content(): string {
    return this.props.content;
  }
}
