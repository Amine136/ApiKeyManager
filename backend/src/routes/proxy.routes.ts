import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { RequestValidationError, validateProxyInput } from '../lib/request-validation.js';
import { consumeRateLimit } from '../lib/request-throttle.js';
import { env } from '../config/env.js';
import { handleProxy } from '../services/proxy.service.js';

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
    // Proxy — requires any valid bearer token (ADMIN or CLIENT)
    app.post('/api/v1/proxy', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        try {
            const input = validateProxyInput(request.body);
            const ipRate = await consumeRateLimit(`proxy:ip:${request.ip}`, env.PROXY_RATE_LIMIT_PER_IP_PER_MINUTE, 60_000);
            if (!ipRate.allowed) {
                reply.header('Retry-After', String(ipRate.retryAfterSeconds));
                reply.code(429).send({ status: 'error', message: 'Too many requests from this IP. Please retry later.' });
                return;
            }

            const clientRate = await consumeRateLimit(
                `proxy:client:${request.client!.id}`,
                env.PROXY_RATE_LIMIT_PER_CLIENT_PER_MINUTE,
                60_000
            );
            if (!clientRate.allowed) {
                reply.header('Retry-After', String(clientRate.retryAfterSeconds));
                reply.code(429).send({ status: 'error', message: 'Client request rate exceeded. Please retry later.' });
                return;
            }

            const result = await handleProxy(input, request.client!.id);
            reply.code(result.statusCode).send(result.body);
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });
}
