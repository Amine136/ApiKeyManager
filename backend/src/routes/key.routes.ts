import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import { RequestValidationError, validateKeyPayload } from '../lib/request-validation.js';
import * as keyService from '../services/key.service.js';

export async function keyRoutes(app: FastifyInstance): Promise<void> {
    // List all keys
    app.get('/api/v1/keys', {
        preHandler: [authenticateAdminSession],
    }, async (_request, reply) => {
        const keys = await keyService.listKeys();
        // Don't expose encrypted keys in list
        const safeKeys = keys.map((k) => ({ ...k, encryptedKey: '***' }));
        reply.send({ status: 'success', data: safeKeys });
    });

    // Create key
    app.post('/api/v1/keys', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateKeyPayload(request.body);
            const key = await keyService.createKey(payload);

            // Don't expose encrypted key in response
            reply.code(201).send({ status: 'success', data: { ...key, encryptedKey: '***' } });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Delete key
    app.delete<{ Params: { id: string } }>('/api/v1/keys/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const deleted = await keyService.deleteKey(request.params.id);
        if (!deleted) {
            reply.code(404).send({ status: 'error', message: 'Key not found' });
            return;
        }
        reply.send({ status: 'success', message: 'Key deleted' });
    });

    // Toggle key status (ACTIVE ↔ DISABLED)
    app.patch<{ Params: { id: string } }>('/api/v1/keys/:id/toggle', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const key = await keyService.toggleKey(request.params.id);
        if (!key) {
            reply.code(404).send({ status: 'error', message: 'Key not found' });
            return;
        }
        reply.send({ status: 'success', data: { ...key, encryptedKey: '***' } });
    });
}
