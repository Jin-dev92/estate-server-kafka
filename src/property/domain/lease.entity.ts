import { LeaseStatus } from './lease-status.enum';
import { DomainError } from '../../common/errors/domain-error';

interface LeaseProps {
  id: string | null;
  unitId: string;
  tenantId: string;
  status: LeaseStatus;
}

export class Lease {
  private constructor(private readonly props: LeaseProps) {}

  static create(input: { unitId: string; tenantId: string }): Lease {
    if (!input.unitId) throw new DomainError('호실 ID는 필수입니다.');
    if (!input.tenantId) throw new DomainError('입주자 ID는 필수입니다.');
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
