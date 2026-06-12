import { LeaseStatus } from './lease-status.enum';

interface LeaseProps {
  id: string | null;
  unitId: string;
  tenantId: string;
  status: LeaseStatus;
}

export class Lease {
  private constructor(private readonly props: LeaseProps) {}

  static create(input: { unitId: string; tenantId: string }): Lease {
    if (!input.unitId) throw new Error('unitId is required');
    if (!input.tenantId) throw new Error('tenantId is required');
    return new Lease({
      id: null,
      unitId: input.unitId,
      tenantId: input.tenantId,
      status: LeaseStatus.ACTIVE,
    });
  }

  static reconstitute(props: LeaseProps): Lease {
    return new Lease(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get unitId(): string {
    return this.props.unitId;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get status(): LeaseStatus {
    return this.props.status;
  }
}
