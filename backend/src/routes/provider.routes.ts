import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import { RequestValidationError, validateProviderCreateBody, validateProviderUpdateBody } from '../lib/request-validation.js';
import * as providerService from '../services/provider.service.js';

export async function providerRoutes(app: FastifyInstance): Promise<void> {
    // List all providers
    app.get('/api/v1/providers', {
        preHandler: [authenticateAdminSession],
    }, async (_request, reply) => {
        const providers = await providerService.listProviders();
        reply.send({ status: 'success', data: providers });
    });

    // Get single provider
    app.get<{ Params: { id: string } }>('/api/v1/providers/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const provider = await providerService.getProvider(request.params.id);
        if (!provider) {
            reply.code(404).send({ status: 'error', message: 'Provider not found' });
            return;
        }
        reply.send({ status: 'success', data: provider });
    });

    // Create provider
    app.post('/api/v1/providers', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = await validateProviderCreateBody(request.body);
            const provider = await providerService.createProvider(payload);
            reply.code(201).send({ status: 'success', data: provider });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Update provider
    app.put<{ Params: { id: string } }>('/api/v1/providers/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const existingProvider = await providerService.getProvider(request.params.id);
        if (!existingProvider) {
            reply.code(404).send({ status: 'error', message: 'Provider not found' });
            return;
        }

        try {
            const payload = await validateProviderUpdateBody(request.body, existingProvider);
            const provider = await providerService.updateProvider(request.params.id, payload);
            reply.send({ status: 'success', data: provider });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Delete provider
    app.delete<{ Params: { id: string } }>('/api/v1/providers/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const deleted = await providerService.deleteProvider(request.params.id);
        if (!deleted) {
            reply.code(404).send({ status: 'error', message: 'Provider not found' });
            return;
        }
        reply.send({ status: 'success', message: 'Provider deleted' });
    });

    // Toggle provider active status
    app.patch<{ Params: { id: string } }>('/api/v1/providers/:id/toggle', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const provider = await providerService.toggleProvider(request.params.id);
        if (!provider) {
            reply.code(404).send({ status: 'error', message: 'Provider not found' });
            return;
        }
        reply.send({ status: 'success', data: provider });
    });
}
