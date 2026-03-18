import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import {
    RequestValidationError,
    validateBulkRulePayload,
    validateRulePayload,
} from '../lib/request-validation.js';
import * as ruleService from '../services/keyModelRule.service.js';

export async function keyModelRuleRoutes(app: FastifyInstance): Promise<void> {
    // List all rules (optionally filtered by keyId or modelName)
    app.get('/api/v1/key-model-rules', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const query = request.query as any;
        let rules;
        if (query.keyId) {
            rules = await ruleService.listRulesByKey(query.keyId);
        } else if (query.modelName) {
            rules = await ruleService.listRulesByModel(query.modelName);
        } else {
            rules = await ruleService.listAllRules();
        }
        reply.send({ status: 'success', data: rules });
    });

    // Create rule (link key ↔ model with rate limit rules)
    app.post('/api/v1/key-model-rules', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateRulePayload(request.body);
            const rule = await ruleService.createRule(payload);
            reply.code(201).send({ status: 'success', data: rule });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Bulk create rules (multiple keys × multiple models)
    app.post('/api/v1/key-model-rules/bulk', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        try {
            const payload = validateBulkRulePayload(request.body);
            const result = await ruleService.bulkCreateRules(
                payload.keyIds,
                payload.models,
                payload.rules,
            );

            reply.code(201).send({
                status: 'success',
                data: result,
                message: `Created ${result.created} rules, skipped ${result.skipped} duplicates`,
            });
        } catch (error) {
            if (error instanceof RequestValidationError) {
                reply.code(error.statusCode).send({ status: 'error', message: error.message });
                return;
            }
            throw error;
        }
    });

    // Delete rule
    app.delete<{ Params: { id: string } }>('/api/v1/key-model-rules/:id', {
        preHandler: [authenticateAdminSession],
    }, async (request, reply) => {
        const deleted = await ruleService.deleteRule(request.params.id);
        if (!deleted) {
            reply.code(404).send({ status: 'error', message: 'Rule not found' });
            return;
        }
        reply.send({ status: 'success', message: 'Rule deleted' });
    });
}
