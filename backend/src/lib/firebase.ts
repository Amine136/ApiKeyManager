import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { env } from '../config/env.js';

if (!admin.apps.length) {
    const serviceAccountPath = resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH);
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'));

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: env.FIREBASE_PROJECT_ID,
    });
}

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
export { db };
