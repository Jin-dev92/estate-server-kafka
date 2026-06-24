import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class UpdateProfileDto {
  @ApiProperty({ example: '김철수' })
  @IsString()
  @IsNotEmpty()
  name: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;
}

export class ProfileResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'a@b.com' }) email: string;
  @ApiProperty({ example: '김철수' }) name: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role: Role;
}
