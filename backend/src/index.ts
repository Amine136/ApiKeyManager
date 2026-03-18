import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { providerRoutes } from './routes/provider.routes.js';
import { keyRoutes } from './routes/key.routes.js';
import { clientRoutes } from './routes/client.routes.js';
import { usageRoutes } from './routes/usage.routes.js';
import { proxyRoutes } from './routes/proxy.routes.js';
import { modelRoutes } from './routes/model.routes.js';
import { keyModelRuleRoutes } from './routes/keyModelRule.routes.js';
import { authRoutes } from './routes/auth.routes.js';

async function main() {
    const app = Fastify({
        logger: true,
    });

    // CORS
    await app.register(cors, {
        origin: env.FRONTEND_URL,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true,
    });

    // Register routes
    await app.register(providerRoutes);
    await app.register(keyRoutes);
    await app.register(clientRoutes);
    await app.register(usageRoutes);
    await app.register(proxyRoutes);
    await app.register(modelRoutes);
    await app.register(keyModelRuleRoutes);
    await app.register(authRoutes);

    // Health check
    app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

    // Start
    try {
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        console.log(`🚀 Server listening on http://localhost:${env.PORT}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}

main();
