import { Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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
import { ListMyLeasesUseCase } from '../application/list-my-leases.use-case';
import { EndLeaseUseCase } from '../application/end-lease.use-case';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { LeaseViewDto } from './dto/lease-view.dto';

@ApiTags('property')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller()
export class LeaseController {
  constructor(
    private readonly listMyLeases: ListMyLeasesUseCase,
    private readonly endLease: EndLeaseUseCase,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('me/leases')
  @ApiOperation({ summary: '내 임대 목록 조회(건물·호실 이름 포함)' })
  @ApiResponse({ status: 200, type: [LeaseViewDto] })
  async myLeasesHandler(
    @CurrentUser() user: TokenPayload,
  ): Promise<LeaseViewDto[]> {
    return this.listMyLeases.execute(user.sub);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Patch('leases/:id/end')
  @ApiOperation({ summary: '계약 종료(건물 OWNER 전용)' })
  @ApiParam({ name: 'id', description: '계약(Lease) ID' })
  @ApiResponse({ status: 200, description: '종료된 계약' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 소유자 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '계약 없음',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: '이미 종료된 계약',
  })
  async endLeaseHandler(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ) {
    const lease = await this.endLease.execute({
      userId: user.sub,
      leaseId: id,
    });
    return {
      id: lease.id,
      unitId: lease.unitId,
      status: lease.status,
      endedAt: lease.endedAt,
    };
  }
}
