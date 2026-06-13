import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'owner@estate.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'pw123456' })
  @IsNotEmpty()
  password: string;
}
