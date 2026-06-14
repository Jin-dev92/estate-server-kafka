import { HttpStatus } from '@nestjs/common';
import { AppErrorSpec } from '../common/errors/app-exception';

export const ChatError = {
  BUILDING_NOT_FOUND: {
    code: 'CHAT_BUILDING_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '건물을 찾을 수 없습니다.',
  },
  NOT_ROOM_PARTICIPANT: {
    code: 'CHAT_NOT_ROOM_PARTICIPANT',
    status: HttpStatus.FORBIDDEN,
    message: '대화방 참가자가 아닙니다.',
  },
  TENANT_NOT_MEMBER: {
    code: 'CHAT_TENANT_NOT_MEMBER',
    status: HttpStatus.FORBIDDEN,
    message: '해당 건물의 입주자가 아닙니다.',
  },
  ROOM_NOT_FOUND: {
    code: 'CHAT_ROOM_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '대화방을 찾을 수 없습니다.',
  },
} as const satisfies Record<string, AppErrorSpec>;
