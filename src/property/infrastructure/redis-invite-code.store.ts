import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const INVITE_TTL_SEC = 60 * 60 * 24; // 24시간

@Injectable()
export class RedisInviteCodeStore implements InviteCodeStore {
  constructor(private readonly redis: RedisService) {}

  private key(code: string): string {
    return `invite:${code}`;
  }

  async issue(payload: InviteCodePayload): Promise<IssuedInvite> {
    const code = randomBytes(9).toString('base64url');
    await this.redis.set(
      this.key(code),
      JSON.stringify(payload),
      'EX',
      INVITE_TTL_SEC,
    );
    return { code, expiresInSec: INVITE_TTL_SEC };
  }

  async redeem(code: string): Promise<InviteCodePayload | null> {
    // GETDEL: 읽는 즉시 삭제 → 동시 요청이 와도 한 번만 성공(단일 사용 보장)
    const raw = await this.redis.getdel(this.key(code));
    if (!raw) return null;
    return JSON.parse(raw) as InviteCodePayload;
  }

  async peek(code: string): Promise<InviteCodePayload | null> {
    // GET: 삭제하지 않고 조회만(redeem과 달리 코드를 소비하지 않음)
    const raw = await this.redis.get(this.key(code));
    if (!raw) return null;
    return JSON.parse(raw) as InviteCodePayload;
  }
}
