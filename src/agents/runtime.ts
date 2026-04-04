import { AgentConfig, AgentContext, AgentResponse } from '../types/agents';
import { infer } from '../integrations/zero-g/compute';

export class Agent {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async run(input?: string): Promise<AgentResponse> {
    const { name, systemPrompt, providers, actions } = this.config;

    // 1. Gather context from all providers
    console.log(`[${name}] Gathering context from ${providers.length} providers`);
    const providerResults: Record<string, string> = {};
    const settled = await Promise.allSettled(
      providers.map((p) => p.handler().then((result) => ({ name: p.name, result })))
    );
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        providerResults[outcome.value.name] = outcome.value.result;
      } else {
        console.warn(`[${name}] Provider failed:`, outcome.reason);
      }
    }

    const context: AgentContext = {
      providerResults,
      timestamp: new Date().toISOString(),
    };

    // 2. Build prompt
    let prompt = `Current context:\n${JSON.stringify(context.providerResults, null, 2)}`;
    if (input) {
      prompt += `\n\nUser input:\n${input}`;
    }
    prompt += `\n\nAvailable actions:\n${actions.map((a) => `- ${a.name}: ${a.description}`).join('\n')}`;
    prompt += `\n\nRespond with JSON: { "action": "<action_name> or null", "args": { ... }, "reasoning": "..." }`;

    // 3. Call inference
    console.log(`[${name}] Calling inference`);
    const response = await infer(systemPrompt, prompt);

    // 4. Execute chosen action
    if (!response.action) {
      console.log(`[${name}] No action chosen`);
      return response;
    }

    const action = actions.find((a) => a.name === response.action);
    if (!action) {
      const available = actions.map((a) => a.name).join(', ');
      console.error(`[${name}] Unknown action "${response.action}". Available: ${available}`);
      return response;
    }

    console.log(`[${name}] Executing action: ${action.name}`);
    try {
      await action.handler(response.args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${name}] Action "${action.name}" failed: ${message}`);
      response.reasoning += ` | Action error: ${message}`;
    }

    return response;
  }
}

export default Agent;
