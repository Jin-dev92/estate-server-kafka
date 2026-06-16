import { PrismaTransactionRunner } from './prisma-transaction-runner';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionClient } from '../domain/transaction-runner';

describe('PrismaTransactionRunner', () => {
  it('run은 prisma.$transaction에 콜백을 위임하고 결과를 반환한다', async () => {
    const tx = {} as TransactionClient;
    const prisma = {
      $transaction: jest.fn((fn: (t: TransactionClient) => Promise<unknown>) =>
        fn(tx),
      ),
    };
    const runner = new PrismaTransactionRunner(
      prisma as unknown as PrismaService,
    );

    const result = await runner.run((t) => {
      expect(t).toBe(tx);
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
