import { ApiProperty } from '@nestjs/swagger';

// 알림 목록 응답 1건의 형태(Swagger 노출용).
export class NotificationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) body!: string | null;
  @ApiProperty() entityType!: string;
  @ApiProperty() entityId!: string;
  @ApiProperty({ nullable: true }) buildingId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  readAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class UnreadCountResponseDto {
  @ApiProperty({ example: 3 }) count!: number;
}
