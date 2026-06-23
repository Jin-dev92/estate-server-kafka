import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { RolesGuard } from '../../auth/interface/roles.guard';
import { Roles } from '../../auth/interface/roles.decorator';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { Role } from '../../auth/domain/role.enum';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreateUnitUseCase } from '../application/create-unit.use-case';
import { ListBuildingUnitsUseCase } from '../application/list-building-units.use-case';
import { CreateUnitDto } from './dto/create-unit.dto';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { UnitViewDto } from './dto/unit-view.dto';

@ApiTags('property')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller()
export class UnitController {
  constructor(
    private readonly createUnit: CreateUnitUseCase,
    private readonly listUnits: ListBuildingUnitsUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings/:buildingId/units')
  @ApiParam({ name: 'buildingId', description: '호실을 추가할 건물 ID' })
  @ApiOperation({ summary: '호실 생성(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '생성된 호실' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '건물 없음',
  })
  async createUnitHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateUnitDto,
  ) {
    const unit = await this.createUnit.execute({
      ownerId: user.sub,
      buildingId,
      name: dto.name,
      floor: dto.floor,
    });
    return {
      id: unit.id,
      buildingId: unit.buildingId,
      name: unit.name,
      floor: unit.floor,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Get('buildings/:buildingId/units')
  @ApiParam({ name: 'buildingId', description: '호실을 조회할 건물 ID' })
  @ApiOperation({ summary: '건물 호실 목록 조회(OWNER, 건물 소유자)' })
  @ApiResponse({ status: 200, type: [UnitViewDto] })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 소유자 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '건물 없음',
  })
  listUnitsHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
  ): Promise<UnitViewDto[]> {
    return this.listUnits.execute({ ownerId: user.sub, buildingId });
  }
}
