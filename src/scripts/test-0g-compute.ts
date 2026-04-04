import 'dotenv/config';

// Force 0G mode regardless of .env
process.env.COMPUTE_PROVIDER = '0g';

import { infer } from '../integrations/zero-g/compute';

async function main() {
  console.log('\n=== 0G Compute Inference Test (API Key) ===\n');
  console.log('Service URL:', process.env.ZERO_G_SERVICE_URL || 'https://compute-network-6.integratenetwork.work/v1/proxy');
  console.log('API Key set:', !!process.env.ZERO_G_API_KEY);

  const systemPrompt = 'You are a JSON-only responder. Reply with exactly this JSON and nothing else: {"action": null, "args": {}, "reasoning": "0G Compute is working"}';
  const userPrompt = 'Respond now.';

  console.log('\nSending inference request...\n');

  const result = await infer(systemPrompt, userPrompt);

  console.log('\n=== Parsed Result ===');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n=== Verdict ===');
  if (result.action === null && result.reasoning && result.reasoning !== 'Failed to parse LLM response') {
    console.log('SUCCESS — 0G Compute inference is working');
  } else if (result.reasoning === 'Failed to parse LLM response') {
    console.log('PARTIAL — Connected to 0G but response parsing failed');
  } else {
    console.log('UNEXPECTED — Got a response but content differs from expected');
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message || err);
  process.exit(1);
});
