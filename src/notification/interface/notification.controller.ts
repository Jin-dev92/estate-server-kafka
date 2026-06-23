import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { ListNotificationsUseCase } from '../application/list-notifications.use-case';
import { GetUnreadCountUseCase } from '../application/get-unread-count.use-case';
import { MarkAllReadUseCase } from '../application/mark-all-read.use-case';
import { MarkOneReadUseCase } from '../application/mark-one-read.use-case';
import {
  NotificationResponseDto,
  UnreadCountResponseDto,
} from './dto/notification-response.dto';

// 목록 기본/최대 개수(매직넘버 금지).
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

@ApiTags('notification')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly list: ListNotificationsUseCase,
    private readonly unread: GetUnreadCountUseCase,
    private readonly markRead: MarkAllReadUseCase,
    private readonly markOne: MarkOneReadUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: '내 알림 목록(최신순)' })
  @ApiResponse({ status: 200, type: [NotificationResponseDto] })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  async listMine(
    @CurrentUser() user: TokenPayload,
    @Query('limit') limit?: string,
  ): Promise<NotificationResponseDto[]> {
    const n = Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT);
    const rows = await this.list.execute(user.sub, n);
    return rows.map((r) => ({
      id: r.id!,
      type: r.type,
      title: r.title,
      body: r.body,
      entityType: r.entityType,
      entityId: r.entityId,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: (r.createdAt ?? new Date()).toISOString(),
    }));
  }

  @Get('unread-count')
  @ApiOperation({ summary: '미읽음 알림 수(Redis 카운터)' })
  @ApiResponse({ status: 200, type: UnreadCountResponseDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  async unreadCount(
    @CurrentUser() user: TokenPayload,
  ): Promise<UnreadCountResponseDto> {
    return { count: await this.unread.execute(user.sub) };
  }

  @Patch('read')
  @ApiOperation({ summary: '전체 읽음 처리(카운터 리셋)' })
  @ApiResponse({ status: 200, description: '처리 완료' })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  async readAll(@CurrentUser() user: TokenPayload): Promise<{ ok: true }> {
    await this.markRead.execute(user.sub);
    return { ok: true };
  }

  @Patch(':id/read')
  @ApiOperation({ summary: '단건 읽음 처리' })
  @ApiResponse({ status: 200, description: '처리 완료' })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  async readOne(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.markOne.execute(user.sub, id);
    return { ok: true };
  }
}
