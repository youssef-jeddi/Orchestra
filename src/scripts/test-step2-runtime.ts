import 'dotenv/config';
import { Agent } from '../agents/runtime';

async function main() {

    // ── TEST 1: Basic happy path ──────────────────────────────────────────
    console.log('\n=== TEST 1: Happy path — action executes successfully ===');

    let actionWasCalled = false;

    const agent = new Agent({
        name: 'TestAgent',
        systemPrompt: `You are a test agent. You must always respond with exactly this JSON and nothing else:
{"action":"greet","args":{"message":"hello"},"reasoning":"user asked for a greeting"}`,
        providers: [
            {
                name: 'userProvider',
                description: 'Provides user info',
                handler: async () => JSON.stringify({ user: { name: 'Alice', balance: 100 } })
            },
            {
                name: 'timeProvider',
                description: 'Provides current time',
                handler: async () => JSON.stringify({ currentTime: new Date().toISOString() })
            }
        ],
        actions: [
            {
                name: 'greet',
                description: 'Send a greeting',
                parameters: [
                    { name: 'message', type: 'string', description: 'The greeting message', required: true }
                ],
                handler: async (args) => {
                    actionWasCalled = true;
                    console.log('  ✓ Action executed with args:', args);
                    return 'greeted successfully';
                }
            }
        ]
    });

    const result1 = await agent.run('say hello');
    console.log('Response:', JSON.stringify(result1, null, 2));
    console.log('Action was called:', actionWasCalled);

    // ── TEST 2: Provider failure is handled gracefully ────────────────────
    console.log('\n=== TEST 2: One provider crashes — agent continues ===');

    const agent2 = new Agent({
        name: 'ResilientAgent',
        systemPrompt: `You are a test agent. Always respond with exactly:
{"action":"log","args":{"msg":"ok"},"reasoning":"test"}`,
        providers: [
            {
                name: 'goodProvider',
                description: 'Works fine',
                handler: async () => JSON.stringify({ status: 'healthy' })
            },
            {
                name: 'badProvider',
                description: 'Always crashes',
                handler: async (): Promise<string> => { throw new Error('provider exploded'); }
            }
        ],
        actions: [
            {
                name: 'log',
                description: 'Log something',
                parameters: [
                    { name: 'msg', type: 'string', description: 'Message to log', required: true }
                ],
                handler: async (args) => {
                    console.log('  ✓ Action executed despite provider failure, args:', args);
                    return 'logged';
                }
            }
        ]
    });

    const result2 = await agent2.run();
    console.log('Agent completed despite provider crash:', !!result2);

    // ── TEST 3: Unknown action requested by LLM ───────────────────────────
    console.log('\n=== TEST 3: LLM returns unknown action — handled gracefully ===');

    const agent3 = new Agent({
        name: 'GracefulAgent',
        systemPrompt: `You are a test agent. Always respond with exactly:
{"action":"nonExistentAction","args":{},"reasoning":"testing unknown action"}`,
        providers: [],
        actions: [
            {
                name: 'realAction',
                description: 'The only real action',
                parameters: [],
                handler: async () => 'done'
            }
        ]
    });

    const result3 = await agent3.run('trigger unknown action');
    console.log('Returned without crashing:', !!result3);

    // ── TEST 4: No input ──────────────────────────────────────────────────
    console.log('\n=== TEST 4: run() called with no input ===');

    const agent4 = new Agent({
        name: 'NoInputAgent',
        systemPrompt: `You are a test agent. Always respond with exactly:
{"action":"noop","args":{},"reasoning":"no input provided"}`,
        providers: [
            {
                name: 'contextProvider',
                description: 'Some context',
                handler: async () => JSON.stringify({ portfolio: { eth: 1.5, usdc: 500 } })
            }
        ],
        actions: [
            {
                name: 'noop',
                description: 'Do nothing',
                parameters: [],
                handler: async () => {
                    console.log('  ✓ Noop action executed');
                    return 'noop';
                }
            }
        ]
    });

    const result4 = await agent4.run();
    console.log('Completed with no input:', !!result4);

    console.log('\n✅ All runtime tests complete');
}

main().catch(console.error);