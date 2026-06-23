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
import { IssueInviteCodeUseCase } from '../application/issue-invite-code.use-case';
import { PreviewInviteCodeUseCase } from '../application/preview-invite-code.use-case';
import { RedeemInviteCodeUseCase } from '../application/redeem-invite-code.use-case';
import { RedeemInviteDto } from './dto/redeem-invite.dto';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { InvitePreviewDto } from './dto/invite-preview.dto';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';

@ApiTags('property')
// 대부분의 라우트가 JwtAuthGuard로 보호되므로 클래스 레벨에 한 번만 선언한다.
// 예외: GET invite-codes/:code/preview 는 미인증 공개 라우트(가드 없음).
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller()
export class InviteController {
  constructor(
    private readonly issueInvite: IssueInviteCodeUseCase,
    private readonly previewInvite: PreviewInviteCodeUseCase,
    private readonly redeemInvite: RedeemInviteCodeUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('units/:unitId/invite-codes')
  @ApiParam({ name: 'unitId', description: '초대코드를 발급할 호실 ID' })
  @ApiOperation({ summary: '초대코드 발급(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '발급된 초대코드' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '호실 없음',
  })
  async issueInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Param('unitId') unitId: string,
  ) {
    return this.issueInvite.execute({ ownerId: user.sub, unitId });
  }

  @Get('invite-codes/:code/preview')
  @RateLimit({ ipMax: 20 })
  @ApiOperation({ summary: '초대코드 미리보기(미인증, 비소비)' })
  @ApiParam({ name: 'code', description: '미리볼 초대코드' })
  @ApiResponse({ status: 200, type: InvitePreviewDto })
  previewInviteHandler(@Param('code') code: string): Promise<InvitePreviewDto> {
    return this.previewInvite.execute(code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('invite-codes/redeem')
  @ApiOperation({ summary: '초대코드 사용(입주)' })
  @ApiResponse({
    status: 201,
    description: '생성된 임대(Lease). status ∈ ACTIVE | ENDED',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '유효하지 않거나 만료된 초대코드',
  })
  async redeemInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: RedeemInviteDto,
  ) {
    const lease = await this.redeemInvite.execute({
      tenantId: user.sub,
      code: dto.code,
    });
    return { id: lease.id, unitId: lease.unitId, status: lease.status };
  }
}
