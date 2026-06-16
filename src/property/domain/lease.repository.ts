import { Lease } from './lease.entity';
import { TransactionClient } from '../../outbox/domain/transaction-runner';

export const LEASE_REPOSITORY = Symbol('LEASE_REPOSITORY');

export interface LeaseRepository {
  save(lease: Lease, tx?: TransactionClient): Promise<Lease>;
  findByTenant(tenantId: string): Promise<Lease[]>;
  findById(id: string): Promise<Lease | null>;
  update(lease: Lease, tx?: TransactionClient): Promise<Lease>;
}
