import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<FastifyReply>();
        const request = ctx.getRequest<FastifyRequest>();

        let httpStatusCode = HttpStatus.INTERNAL_SERVER_ERROR;
        let problemBody: any = {
            type: 'https://eso.dev/errors/internal-error',
            title: 'Internal Server Error',
            status: 500,
            code: 'INTERNAL_SERVER_ERROR',
            detail: 'An unexpected internal error occurred',
            instance: request?.url,
            traceId: `trace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        };

        if (exception instanceof HttpException) {
            httpStatusCode = exception.getStatus();
            const res = exception.getResponse();
            if (typeof res === 'object' && res !== null) {
                problemBody = {
                    ...problemBody,
                    status: httpStatusCode,
                    ...res,
                    instance: request?.url,
                };
            } else if (typeof res === 'string') {
                problemBody.detail = res;
                problemBody.status = httpStatusCode;
            }
        } else if (exception instanceof Error) {
            problemBody.detail = exception.message;
        }

        response
            .status(httpStatusCode)
            .header('content-type', 'application/problem+json')
            .send(problemBody);
    }
}
