import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';

const STATUS_TITLES: Record<number, { title: string; code: string; type: string }> = {
    400: { title: 'Bad Request', code: 'BAD_REQUEST', type: 'https://eso.dev/errors/bad-request' },
    401: { title: 'Unauthorized', code: 'UNAUTHORIZED', type: 'https://eso.dev/errors/unauthorized' },
    403: { title: 'Forbidden', code: 'FORBIDDEN', type: 'https://eso.dev/errors/forbidden' },
    404: { title: 'Not Found', code: 'NOT_FOUND', type: 'https://eso.dev/errors/not-found' },
    409: { title: 'Conflict', code: 'CONFLICT', type: 'https://eso.dev/errors/conflict' },
    500: { title: 'Internal Server Error', code: 'INTERNAL_SERVER_ERROR', type: 'https://eso.dev/errors/internal-error' },
    503: { title: 'Service Unavailable', code: 'SERVICE_UNAVAILABLE', type: 'https://eso.dev/errors/service-unavailable' },
};

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<FastifyReply>();
        const request = ctx.getRequest<FastifyRequest>();

        let httpStatusCode = HttpStatus.INTERNAL_SERVER_ERROR;
        const defaultMeta = STATUS_TITLES[500];

        let problemBody: any = {
            type: defaultMeta.type,
            title: defaultMeta.title,
            status: 500,
            code: defaultMeta.code,
            detail: 'An unexpected internal error occurred',
            instance: request?.url,
            traceId: `trace-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        };

        if (exception instanceof HttpException) {
            httpStatusCode = exception.getStatus();
            const statusMeta = STATUS_TITLES[httpStatusCode] || {
                title: 'HTTP Error',
                code: `HTTP_${httpStatusCode}`,
                type: `https://eso.dev/errors/http-${httpStatusCode}`,
            };

            problemBody.status = httpStatusCode;
            problemBody.title = statusMeta.title;
            problemBody.code = statusMeta.code;
            problemBody.type = statusMeta.type;

            const res = exception.getResponse();
            if (typeof res === 'object' && res !== null) {
                const resObj = res as Record<string, any>;
                if (resObj.message) {
                    if (Array.isArray(resObj.message)) {
                        problemBody.detail = resObj.message.join('; ');
                        problemBody.validationErrors = resObj.message;
                    } else if (typeof resObj.message === 'string') {
                        problemBody.detail = resObj.message;
                    }
                }
                if (resObj.code) problemBody.code = resObj.code;
                if (resObj.error) problemBody.error = resObj.error;
                else if (problemBody.code) problemBody.error = problemBody.code;
                if (resObj.title) problemBody.title = resObj.title;
                if (resObj.type) problemBody.type = resObj.type;
                if (resObj.detail) problemBody.detail = resObj.detail;
                if (resObj.status !== undefined) problemBody.status = resObj.status;
            } else if (typeof res === 'string') {
                problemBody.detail = res;
            }
        } else {
            // Unhandled internal errors: NEVER leak exception message / stack
            httpStatusCode = HttpStatus.INTERNAL_SERVER_ERROR;
            problemBody.status = 500;
            problemBody.detail = 'An unexpected internal error occurred';
        }

        response
            .status(httpStatusCode)
            .header('content-type', 'application/problem+json')
            .send(problemBody);
    }
}
