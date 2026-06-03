import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';

    const message =
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
        ? (exceptionResponse as { message: string | string[] }).message
        : String(exceptionResponse);

    const error =
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'error' in exceptionResponse
        ? String((exceptionResponse as { error: string }).error)
        : HttpStatus[statusCode] || 'Error';

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Unhandled exception for ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: Record<string, unknown> = {
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    if (process.env.NODE_ENV !== 'production' && !(exception instanceof HttpException)) {
      body.details = exception instanceof Error ? exception.message : String(exception);
      if (exception instanceof Error && exception.stack) {
        body.stack = exception.stack;
      }
    }

    response.status(statusCode).json(body);
  }
}
