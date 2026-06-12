import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class PrismaLeaseRepository implements LeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.create({
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        status: lease.status,
      },
    });
    return Lease.reconstitute({
      id: row.id,
      unitId: row.unitId,
      tenantId: row.tenantId,
      status: row.status as LeaseStatus,
    });
  }

  async findByTenant(tenantId: string): Promise<Lease[]> {
    const rows = await this.prisma.lease.findMany({ where: { tenantId } });
    return rows.map((row) =>
      Lease.reconstitute({
        id: row.id,
        unitId: row.unitId,
        tenantId: row.tenantId,
        status: row.status as LeaseStatus,
      }),
    );
  }
}
