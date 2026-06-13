import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class SignUpDto {
  @ApiProperty({ example: 'owner@estate.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '김철수' })
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'pw123456', minLength: 8 })
  @MinLength(8)
  password: string;
}
