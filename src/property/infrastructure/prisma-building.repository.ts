import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Building } from '../domain/building.entity';
import { BuildingRepository } from '../domain/building.repository';

@Injectable()
export class PrismaBuildingRepository implements BuildingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(building: Building): Promise<Building> {
    const row = await this.prisma.building.create({
      data: {
        ownerId: building.ownerId,
        name: building.name,
        address: building.address,
      },
    });
    return Building.reconstitute({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      address: row.address,
    });
  }

  async findById(id: string): Promise<Building | null> {
    const row = await this.prisma.building.findUnique({ where: { id } });
    if (!row) return null;
    return Building.reconstitute({
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      address: row.address,
    });
  }

  async findByOwner(ownerId: string): Promise<Building[]> {
    const rows = await this.prisma.building.findMany({ where: { ownerId } });
    return rows.map((row) =>
      Building.reconstitute({
        id: row.id,
        ownerId: row.ownerId,
        name: row.name,
        address: row.address,
      }),
    );
  }
}
