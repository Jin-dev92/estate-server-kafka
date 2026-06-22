export const INVITE_CODE_STORE = Symbol('INVITE_CODE_STORE');

export interface InviteCodePayload {
  unitId: string;
  issuedBy: string;
}

export interface IssuedInvite {
  code: string;
  expiresInSec: number;
}

export interface InviteCodeStore {
  issue(payload: InviteCodePayload): Promise<IssuedInvite>;
  // 단일 사용(원자적 GETDEL). 만료·이미 사용·존재하지 않음은 모두 null.
  redeem(code: string): Promise<InviteCodePayload | null>;
  // 소비하지 않고 조회만(미리보기용). 만료·없음이면 null.
  peek(code: string): Promise<InviteCodePayload | null>;
}
