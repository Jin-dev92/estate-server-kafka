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
    return this.prisma.$transaction(fn);
  }
}
