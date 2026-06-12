import { Building } from './building.entity';

export const BUILDING_REPOSITORY = Symbol('BUILDING_REPOSITORY');

export interface BuildingRepository {
  save(building: Building): Promise<Building>;
  findById(id: string): Promise<Building | null>;
  findByOwner(ownerId: string): Promise<Building[]>;
}
