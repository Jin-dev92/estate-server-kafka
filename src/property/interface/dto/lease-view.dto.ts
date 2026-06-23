import { ApiProperty } from '@nestjs/swagger';
import { LeaseStatus } from '../../domain/lease-status.enum';

export class LeaseViewDto {
  @ApiProperty() id: string;
  @ApiProperty() unitId: string;
  @ApiProperty({ nullable: true, type: String }) unitName: string | null;
  @ApiProperty({ nullable: true, type: String }) buildingName: string | null;
  @ApiProperty({ nullable: true, type: String }) buildingId: string | null;
  @ApiProperty({ enum: LeaseStatus, enumName: 'LeaseStatus' }) status: LeaseStatus;
}
