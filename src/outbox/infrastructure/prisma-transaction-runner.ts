import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TransactionClient,
  TransactionRunner,
} from '../domain/transaction-runner';

@Injectable()
export class PrismaTransactionRunner implements TransactionRunner {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    // interactive transaction: 콜백이 throw하면 전체 롤백.
    // ⚠️ emit은 이 트랜잭션 안에서 실행된다. Prisma 기본 interactive-tx timeout은 약 5초.
    // OUTBOX_BATCH_SIZE가 크거나 Kafka가 느리면 tx가 타임아웃(행은 PENDING 유지 → 다음 폴링 재시도).
    // batch 크기는 기본 timeout 대비 여유 있게 유지해야 한다.
    return this.prisma.$transaction(fn);
  }
}
