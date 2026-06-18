// ⚠️ TEMP — Claude PR 리뷰(DDD 위반 탐지) 검증용 임시 코드.
// 일부러 DDD 레이어 경계·의존성 역전을 위반했다. 테스트 후 삭제(머지 금지).
import { PrismaClient } from '@prisma/client';
import { HttpException, HttpStatus } from '@nestjs/common';

// domain 레이어인데 infrastructure(Prisma)와 HTTP를 직접 다룬다.
export class DddViolationDemoService {
  // ❌ 도메인이 Prisma(인프라)를 직접 인스턴스화 — 의존성 역전·레이어 경계 위반
  private readonly prisma = new PrismaClient();

  async run(value: number): Promise<void> {
    // ❌ 도메인 로직이 DB 커넥션·HTTP 예외에 직접 결합 — 도메인 로직 누수
    await this.prisma.$connect();
    if (value < 0) {
      throw new HttpException('invalid', HttpStatus.BAD_REQUEST);
    }
  }
}
