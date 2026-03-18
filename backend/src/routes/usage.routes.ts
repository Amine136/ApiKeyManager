import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import * as usageService from '../services/usage.service.js';
import * as keyService from '../services/key.service.js';
import * as modelService from '../services/model.service.js';
import * as keyModelRuleService from '../services/keyModelRule.service.js';

export async function usageRoutes(app: FastifyInstance): Promise<void> {
    app.get('/api/v1/dashboard/bootstrap', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const query = request.query as any;
        const range = query.range ?? 'today';

        if (!['1h', 'today', '7d', '30d'].includes(range)) {
            reply.code(400).send({ status: 'error', message: 'range must be one of: 1h, today, 7d, 30d' });
            return;
        }

        const [keys, models, keyModelRules, dashboard] = await Promise.all([
            keyService.listKeys(),
            modelService.listModels(),
            keyModelRuleService.listAllRules(),
            usageService.getDashboardData(range),
        ]);

        reply.send({
            status: 'success',
            data: {
                keys,
                models,
                keyModelRules,
                dashboard,
            },
        });
    });

    app.get('/api/v1/usage/dashboard', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const query = request.query as any;
        const range = query.range ?? 'today';

        if (!['1h', 'today', '7d', '30d'].includes(range)) {
            reply.code(400).send({ status: 'error', message: 'range must be one of: 1h, today, 7d, 30d' });
            return;
        }

        const dashboard = await usageService.getDashboardData(range);
        reply.send({ status: 'success', data: dashboard });
    });

    // Get usage logs
    app.get('/api/v1/usage/logs', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const query = request.query as any;
        const logs = await usageService.getLogs({
            providerId: query.providerId,
            status: query.status,
            limit: query.limit ? parseInt(query.limit, 10) : undefined,
        });
        reply.send({ status: 'success', data: logs });
    });

    // Get usage stats
    app.get('/api/v1/usage/stats', {
        preHandler: [authenticateAdminSession],
    }, async (_request, reply) => {
        const stats = await usageService.getStats();
        reply.send({ status: 'success', data: stats });
    });
}
