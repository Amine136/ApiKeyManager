import { FastifyInstance } from 'fastify';
import { authenticateAdminSession } from '../middleware/auth.js';
import {
    RequestValidationError,
    validateBulkRulePayload,
    validateRulePayload,
} from '../lib/request-validation.js';
import * as ruleService from '../services/keyModelRule.service.js';
import * as keyService from '../services/key.service.js';
import * as modelService from '../services/model.service.js';

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
            const [key, model] = await Promise.all([
                keyService.getKey(payload.keyId),
                modelService.getModel(payload.modelId),
            ]);

            if (!key) {
                reply.code(404).send({ status: 'error', message: 'API key not found' });
                return;
            }
            if (!model) {
                reply.code(404).send({ status: 'error', message: 'Model not found' });
                return;
            }
            if (key.providerId !== model.providerId) {
                reply.code(400).send({
                    status: 'error',
                    message: 'API key and model must belong to the same provider',
                });
                return;
            }
            if (model.name !== payload.modelName) {
                reply.code(400).send({
                    status: 'error',
                    message: 'modelName must match the selected model',
                });
                return;
            }

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
            const [keys, models] = await Promise.all([
                Promise.all(payload.keyIds.map((keyId) => keyService.getKey(keyId))),
                Promise.all(payload.models.map((model) => modelService.getModel(model.id))),
            ]);

            const missingKeyId = keys.findIndex((key) => !key);
            if (missingKeyId !== -1) {
                reply.code(404).send({ status: 'error', message: `API key not found: ${payload.keyIds[missingKeyId]}` });
                return;
            }

            const missingModelIndex = models.findIndex((model) => !model);
            if (missingModelIndex !== -1) {
                reply.code(404).send({ status: 'error', message: `Model not found: ${payload.models[missingModelIndex].id}` });
                return;
            }

            const keyDocs = keys as NonNullable<typeof keys[number]>[];
            const modelDocs = models as NonNullable<typeof models[number]>[];
            const keyProviderIds = new Set(keyDocs.map((key) => key.providerId));
            const modelProviderIds = new Set(modelDocs.map((model) => model.providerId));

            if (keyProviderIds.size !== 1 || modelProviderIds.size !== 1 || [...keyProviderIds][0] !== [...modelProviderIds][0]) {
                reply.code(400).send({
                    status: 'error',
                    message: 'All selected API keys and models must belong to the same provider',
                });
                return;
            }

            const mismatchedModelName = payload.models.find((entry, index) => modelDocs[index].name !== entry.name);
            if (mismatchedModelName) {
                reply.code(400).send({
                    status: 'error',
                    message: `Model name mismatch for model ${mismatchedModelName.id}`,
                });
                return;
            }

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
