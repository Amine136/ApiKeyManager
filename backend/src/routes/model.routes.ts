import { FastifyInstance } from 'fastify';
import { authenticate, authenticateAdminSession } from '../middleware/auth.js';
import { RequestValidationError, validateModelPayload } from '../lib/request-validation.js';
import * as modelService from '../services/model.service.js';
import { consumeRateLimit } from '../lib/request-throttle.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
    // Client-safe available models list
    app.get('/api/v1/models/available', {
        preHandler: [authenticate],
    }, async (request, reply) => {
        const ipRate = await consumeRateLimit(`models-available:ip:${request.ip}`, 60, 60_000);
        if (!ipRate.allowed) {
            reply.header('Retry-After', String(ipRate.retryAfterSeconds));
            reply.code(429).send({ status: 'error', message: 'Too many requests from this IP. Please retry later.' });
            return;
        }

        const clientRate = await consumeRateLimit(`models-available:client:${request.client!.id}`, 30, 60_000);
        if (!clientRate.allowed) {
            reply.header('Retry-After', String(clientRate.retryAfterSeconds));
            reply.code(429).send({ status: 'error', message: 'Client request rate exceeded. Please retry later.' });
            return;
        }

        const query = request.query as { format?: string };
        if (query.format === 'catalog') {
            const catalog = await modelService.getAvailableModelCatalog();
            reply.send({ status: 'success', data: catalog });
            return;
        }

        const models = await modelService.listAvailableModels();
        reply.send({ status: 'success', data: models });
    });

    // List all models
    app.get('/api/v1/models', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const query = request.query as any;
        const models = query.providerId
            ? await modelService.listModelsByProvider(query.providerId)
            : await modelService.listModels();
        reply.send({ status: 'success', data: models });
    });

    // Create model
    app.post('/api/v1/models', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateModelPayload(request.body);
            const model = await modelService.createModel(payload);
            reply.code(201).send({ status: 'success', data: model });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Update model
    app.put<{ Params: { id: string } }>('/api/v1/models/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateModelPayload(request.body);
            const model = await modelService.updateModel(request.params.id, payload);
            if (!model) {
                reply.code(404).send({ status: 'error', message: 'Model not found' });
                return;
            }
            reply.send({ status: 'success', data: model });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    app.patch<{ Params: { id: string } }>('/api/v1/models/:id/freeze', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const model = await modelService.toggleModelFreeze(request.params.id);
        if (!model) {
            reply.code(404).send({ status: 'error', message: 'Model not found' });
            return;
        }
        reply.send({ status: 'success', data: model });
    });

    // Delete model
    app.delete<{ Params: { id: string } }>('/api/v1/models/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const deleted = await modelService.deleteModel(request.params.id);
        if (!deleted) {
            reply.code(404).send({ status: 'error', message: 'Model not found' });
            return;
        }
        reply.send({ status: 'success', message: 'Model deleted' });
    });
}
