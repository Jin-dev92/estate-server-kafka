import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { PropertyError } from '../property.errors';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

export interface IssueInviteCodeInput {
  ownerId: string;
  unitId: string;
}

@Injectable()
export class IssueInviteCodeUseCase {
  constructor(
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
  ) {}

  async execute(input: IssueInviteCodeInput): Promise<IssuedInvite> {
    const unit = await this.units.findById(input.unitId);
    if (!unit) throw new AppException(PropertyError.UNIT_NOT_FOUND);
    const building = await this.buildings.findById(unit.buildingId);
    if (!building || !building.isOwnedBy(input.ownerId)) {
      throw new AppException(PropertyError.NOT_BUILDING_OWNER);
    }
    return this.invites.issue({ unitId: unit.id!, issuedBy: input.ownerId });
  }
}
