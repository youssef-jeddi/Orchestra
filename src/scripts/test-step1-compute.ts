import 'dotenv/config';
import { infer as computeInfer } from '../integrations/zero-g/compute';

async function main() {
    console.log('\n=== TEST 1: Basic inference ===');
    const result = await computeInfer(
        'You are a helpful agent. Always respond in JSON.',
        'What action should I take to send 10 USDC to alice.eth? Respond with JSON: { "action": "send", "args": { "to": "alice.eth", "amount": 10, "token": "USDC" }, "reasoning": "..." }'
    );
    console.log('Result:', JSON.stringify(result, null, 2));

    console.log('\n=== TEST 2: parseResponse handles bad output ===');
    const result2 = await computeInfer(
        'You are a helpful agent.',
        'Just say "hello world" and nothing else'
    );
    console.log('Result2 (should fallback gracefully):', result2);

    console.log('\n✅ Compute tests done');
}

main().catch(console.error);