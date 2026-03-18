import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import { RequestValidationError, validateModelPayload } from '../lib/request-validation.js';
import * as modelService from '../services/model.service.js';

export async function modelRoutes(app: FastifyInstance): Promise<void> {
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
