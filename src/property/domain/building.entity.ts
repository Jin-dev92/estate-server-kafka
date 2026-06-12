interface BuildingProps {
  id: string | null;
  ownerId: string;
  name: string;
  address: string;
}

export class Building {
  private constructor(private readonly props: BuildingProps) {}

  static create(input: {
    ownerId: string;
    name: string;
    address: string;
  }): Building {
    if (!input.ownerId) throw new Error('ownerId is required');
    if (!input.name) throw new Error('name is required');
    return new Building({
      id: null,
      ownerId: input.ownerId,
      name: input.name,
      address: input.address,
    });
  }

  static reconstitute(props: BuildingProps): Building {
    return new Building(props);
  }

  isOwnedBy(userId: string): boolean {
    return this.props.ownerId === userId;
  }

  get id(): string | null {
    return this.props.id;
  }
  get ownerId(): string {
    return this.props.ownerId;
  }
  get name(): string {
    return this.props.name;
  }
  get address(): string {
    return this.props.address;
  }
}
