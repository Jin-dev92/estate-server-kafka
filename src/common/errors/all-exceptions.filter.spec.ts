import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app-exception';
import { DomainError } from './domain-error';

function mockHost(url = '/x'): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('AppException → 그 status·code·message 봉투', () => {
    const { host, status, json } = mockHost('/posts/1');

    filter.catch(
      new AppException({
        code: 'BOARD_POST_NOT_FOUND',
        status: HttpStatus.NOT_FOUND,
        message: '게시글을 찾을 수 없습니다.',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: 'BOARD_POST_NOT_FOUND',
        message: '게시글을 찾을 수 없습니다.',
        path: '/posts/1',
      }),
    );
  });

  it('DomainError → 422 + 그 code', () => {
    const { host, status, json } = mockHost();

    filter.catch(new DomainError('제목은 필수입니다.'), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_FAILED' }),
    );
  });

  it('Nest 기본 HttpException(404) → 파생 코드 HTTP_404', () => {
    const { host, status, json } = mockHost();

    filter.catch(new NotFoundException('x'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'HTTP_404' }),
    );
  });

  it('알 수 없는 Error → 500 COMMON_INTERNAL_ERROR', () => {
    const { host, status, json } = mockHost();

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'COMMON_INTERNAL_ERROR',
      }),
    );
  });
});
