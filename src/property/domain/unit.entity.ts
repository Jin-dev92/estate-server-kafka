interface UnitProps {
  id: string | null;
  buildingId: string;
  name: string;
  floor: number;
}

export class Unit {
  private constructor(private readonly props: UnitProps) {}

  static create(input: {
    buildingId: string;
    name: string;
    floor: number;
  }): Unit {
    if (!input.buildingId) throw new Error('buildingId is required');
    if (!input.name) throw new Error('name is required');
    return new Unit({
      id: null,
      buildingId: input.buildingId,
      name: input.name,
      floor: input.floor,
    });
  }

  static reconstitute(props: UnitProps): Unit {
    return new Unit(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get buildingId(): string {
    return this.props.buildingId;
  }
  get name(): string {
    return this.props.name;
  }
  get floor(): number {
    return this.props.floor;
  }
}
