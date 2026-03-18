import { createClient } from '../src/services/client.service.js';

async function generateAdmin() {
    console.log('Generating new initial admin token...');
    try {
        const { client, plaintextToken } = await createClient({
            name: 'Initial Admin',
            role: 'ADMIN',
        });
        
        console.log('\n======================================================');
        console.log('ADMIN CREATED SUCCESSFULLY!');
        console.log('Your new Admin Token is:');
        console.log(plaintextToken);
        console.log('======================================================\n');
        console.log('SAVE THIS TOKEN. It will not be shown again and cannot be recovered.');
        console.log('Use this token to log in to the frontend dashboard.');
        
        process.exit(0);
    } catch (err) {
        console.error('Failed to generate admin token:', err);
        process.exit(1);
    }
}

generateAdmin();
