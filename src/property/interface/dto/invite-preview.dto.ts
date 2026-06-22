import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InvitePreviewDto {
  @ApiProperty({ description: '코드 유효 여부' })
  valid: boolean;

  @ApiPropertyOptional({ description: '건물 이름(유효한 경우)' })
  buildingName?: string;

  @ApiPropertyOptional({ description: '호실 이름(유효한 경우)' })
  unitName?: string;
}
