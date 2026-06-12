import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './app-exception';
import { DomainError } from './domain-error';
import { ErrorResponse } from './error-response';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body = this.toErrorResponse(exception, req.url);
    if (body.statusCode >= 500) {
      this.logger.error(
        `${body.code} ${body.statusCode} ${req.url}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    res.status(body.statusCode).json(body);
  }

  private toErrorResponse(exception: unknown, path: string): ErrorResponse {
    const timestamp = new Date().toISOString();

    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        path,
        timestamp,
      };
    }
    if (exception instanceof DomainError) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: exception.code,
        message: exception.message,
        path,
        timestamp,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        statusCode: status,
        code: this.deriveCode(status),
        message: this.extractMessage(exception),
        path,
        timestamp,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'COMMON_INTERNAL_ERROR',
      message: '서버 오류가 발생했습니다.',
      path,
      timestamp,
    };
  }

  private deriveCode(status: number): string {
    if (status === HttpStatus.BAD_REQUEST) return 'COMMON_VALIDATION_FAILED';
    if (status === HttpStatus.UNAUTHORIZED) return 'COMMON_UNAUTHORIZED';
    return `HTTP_${status}`;
  }

  private extractMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message[0];
    return message ?? exception.message;
  }
}
