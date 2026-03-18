import { FastifyInstance } from 'fastify';
import { authenticateAdminSession, createAdminSession, destroyAdminSession } from '../middleware/auth.js';
import { consumeRateLimit } from '../lib/request-throttle.js';
import { env } from '../config/env.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
    app.post('/api/v1/auth/login', async (request, reply) => {
        const rate = await consumeRateLimit(`login:${request.ip}`, env.LOGIN_RATE_LIMIT_ATTEMPTS_PER_MINUTE, 60_000);
        if (!rate.allowed) {
            reply.header('Retry-After', String(rate.retryAfterSeconds));
            reply.code(429).send({ status: 'error', message: 'Too many login attempts. Please try again later.' });
            return;
        }
        await createAdminSession(request, reply);
    });

    app.post('/api/v1/auth/logout', async (request, reply) => {
        await destroyAdminSession(request, reply);
    });

    app.get('/api/v1/auth/me', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        reply.send({
            status: 'success',
            data: {
                id: request.client!.id,
                name: request.client!.name,
                role: request.client!.role,
            },
        });
    });
}
