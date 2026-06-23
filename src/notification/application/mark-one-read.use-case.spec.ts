import { MarkOneReadUseCase } from './mark-one-read.use-case';
import { NotificationRepository } from '../domain/notification.repository';
import { NotificationCounter } from '../domain/notification-counter';

function build(markResult: boolean) {
  const decrements: string[] = [];
  const repo: Partial<NotificationRepository> = {
    markOneRead: () => Promise.resolve(markResult),
  };
  const counter: Partial<NotificationCounter> = {
    decrement: (u: string) => {
      decrements.push(u);
      return Promise.resolve();
    },
  };
  const useCase = new MarkOneReadUseCase(
    repo as NotificationRepository,
    counter as NotificationCounter,
  );
  return { useCase, decrements };
}

describe('MarkOneReadUseCase', () => {
  it('신규 읽음 전이면 카운터를 1회 감소시킨다', async () => {
    const { useCase, decrements } = build(true);
    await useCase.execute('u1', 'n1');
    expect(decrements).toEqual(['u1']);
  });

  it('이미 읽음(전이 없음)이면 카운터를 건드리지 않는다', async () => {
    const { useCase, decrements } = build(false);
    await useCase.execute('u1', 'n1');
    expect(decrements).toEqual([]);
  });
});
