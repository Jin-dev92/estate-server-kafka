import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { RolesGuard } from '../../auth/interface/roles.guard';
import { Roles } from '../../auth/interface/roles.decorator';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { Role } from '../../auth/domain/role.enum';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreateBuildingUseCase } from '../application/create-building.use-case';
import { ListMyBuildingsUseCase } from '../application/list-my-buildings.use-case';
import { CreateBuildingDto } from './dto/create-building.dto';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';

@ApiTags('property')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller()
export class BuildingController {
  constructor(
    private readonly createBuilding: CreateBuildingUseCase,
    private readonly listMyBuildings: ListMyBuildingsUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings')
  @ApiOperation({ summary: '건물 생성(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '생성된 건물' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  async createBuildingHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: CreateBuildingDto,
  ) {
    const building = await this.createBuilding.execute({
      ownerId: user.sub,
      name: dto.name,
      address: dto.address,
    });
    return {
      id: building.id,
      name: building.name,
      address: building.address,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Get('buildings')
  @ApiOperation({ summary: '내 건물 목록 조회(OWNER 전용)' })
  @ApiResponse({ status: 200, description: '내가 소유한 건물 목록' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  async listBuildingsHandler(@CurrentUser() user: TokenPayload) {
    const buildings = await this.listMyBuildings.execute(user.sub);
    return buildings.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
    }));
  }
}
