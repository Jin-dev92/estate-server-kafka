import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Unit } from '../domain/unit.entity';
import { UnitRepository } from '../domain/unit.repository';

@Injectable()
export class PrismaUnitRepository implements UnitRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(unit: Unit): Promise<Unit> {
    const row = await this.prisma.unit.create({
      data: {
        buildingId: unit.buildingId,
        name: unit.name,
        floor: unit.floor,
      },
    });
    return Unit.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      name: row.name,
      floor: row.floor,
    });
  }

  async findById(id: string): Promise<Unit | null> {
    const row = await this.prisma.unit.findUnique({ where: { id } });
    if (!row) return null;
    return Unit.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      name: row.name,
      floor: row.floor,
    });
  }
}
