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
    if (!input.postId) throw new Error('postId is required');
    if (!input.authorId) throw new Error('authorId is required');
    if (!input.content) throw new Error('content is required');
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
