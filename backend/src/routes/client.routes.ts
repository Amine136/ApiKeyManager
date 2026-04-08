import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import { RequestValidationError, validateClientPayload } from '../lib/request-validation.js';
import * as clientService from '../services/client.service.js';

export async function clientRoutes(app: FastifyInstance): Promise<void> {
    // List all clients
    app.get('/api/v1/clients', {
        preHandler: [authenticateAdminSession],
    }, async (_request, reply) => {
        const clients = await clientService.listClients();
        const safeClients = clients.map(clientService.toSafeClient);
        reply.send({ status: 'success', data: safeClients });
    });

    // Create client — returns plaintext token ONCE
    app.post('/api/v1/clients', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateClientPayload(request.body);
            const result = await clientService.createClient(payload);

            reply.code(201).send({
                status: 'success',
                data: {
                    ...clientService.toSafeClient(result.client),
                    plaintextToken: result.plaintextToken,
                },
            });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Delete client
    app.delete<{ Params: { id: string } }>('/api/v1/clients/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const deleted = await clientService.deleteClient(request.params.id);
        if (!deleted) {
            reply.code(404).send({ status: 'error', message: 'Client not found' });
            return;
        }
        reply.send({ status: 'success', message: 'Client deleted' });
    });

    app.patch<{ Params: { id: string } }>('/api/v1/clients/:id/toggle', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const client = await clientService.toggleClient(request.params.id);
        if (!client) {
            reply.code(404).send({ status: 'error', message: 'Client not found' });
            return;
        }
        reply.send({ status: 'success', data: clientService.toSafeClient(client) });
    });

    app.post<{ Params: { id: string } }>('/api/v1/clients/:id/revoke', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const client = await clientService.revokeClient(request.params.id);
        if (!client) {
            reply.code(404).send({ status: 'error', message: 'Client not found' });
            return;
        }
        reply.send({ status: 'success', data: clientService.toSafeClient(client) });
    });

    app.post<{ Params: { id: string } }>('/api/v1/clients/:id/rotate', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const result = await clientService.rotateClientToken(request.params.id);
        if (!result) {
            reply.code(404).send({ status: 'error', message: 'Client not found' });
            return;
        }

        reply.send({
            status: 'success',
            data: {
                ...clientService.toSafeClient(result.client),
                plaintextToken: result.plaintextToken,
            },
        });
    });
}
