import { ApiProperty } from '@nestjs/swagger';

export class UnitViewDto {
  @ApiProperty() id: string;
  @ApiProperty() buildingId: string;
  @ApiProperty() name: string;
  @ApiProperty() floor: number;
}
