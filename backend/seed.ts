/**
 * Seed script — creates the first ADMIN client in Firestore.
 * Run once: npx tsx seed.ts
 */
import { createHash, randomBytes } from 'crypto';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const serviceAccount = JSON.parse(
    readFileSync(resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH!), 'utf-8')
);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
});

const db = admin.firestore();

async function seed() {
    console.log('🌱 Seeding Firestore collections...\n');

    // Create ADMIN client
    const plaintextToken = randomBytes(32).toString('hex');
    const hashedToken = createHash('sha256').update(plaintextToken).digest('hex');
    const now = new Date();

    const clientRef = await db.collection('clients').add({
        name: 'Admin',
        hashedToken,
        role: 'ADMIN',
        isActive: true,
        createdAt: now,
        updatedAt: now,
    });

    console.log('✅ Admin client created!');
    console.log('   Client ID:', clientRef.id);
    console.log('\n🔑 YOUR ADMIN TOKEN (save this — shown only once!):');
    console.log('   ' + plaintextToken);
    console.log('\n   Use this token to login at http://localhost:3001');

    // Create placeholder docs to initialise collections (optional, Firestore is schemaless)
    // Collections are auto-created on first doc write — nothing needed for providers/keys/usageLogs

    console.log('\n✅ Done! Collections will be created automatically on first use.');
    console.log('   - providers      (created via admin UI)');
    console.log('   - apiKeys        (created via admin UI)');
    console.log('   - usageLogs      (created on first proxy call)');

    process.exit(0);
}

seed().catch((err) => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
});
