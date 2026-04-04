import { AgentResponse } from '../../types/agents';

function parseResponse(raw: string): AgentResponse {
  const fallback: AgentResponse = {
    action: null,
    args: {},
    reasoning: 'Failed to parse LLM response',
  };

  try {
    let cleaned = raw.trim();

    // Strip <think>...</think> blocks (Qwen3 thinking mode)
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Strip markdown code fences
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // Try direct parse first
    try {
      const parsed = JSON.parse(cleaned);
      return {
        action: parsed.action ?? null,
        args: parsed.args ?? {},
        reasoning: parsed.reasoning ?? '',
      };
    } catch {
      // Fall through to regex extraction
    }

    // Extract JSON object containing "action" key (find balanced braces)
    const startIdx = cleaned.indexOf('{"action"');
    if (startIdx !== -1) {
      let depth = 0;
      for (let i = startIdx; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(startIdx, i + 1));
            return {
              action: parsed.action ?? null,
              args: parsed.args ?? {},
              reasoning: parsed.reasoning ?? '',
            };
          } catch {
            break;
          }
        }
      }
    }

    // Fallback: greedy regex for any JSON object
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        action: parsed.action ?? null,
        args: parsed.args ?? {},
        reasoning: parsed.reasoning ?? '',
      };
    }

    console.warn('[0G Compute] Could not extract JSON from LLM response, using fallback');
    return fallback;
  } catch (err) {
    console.warn('[0G Compute] parseResponse error:', err);
    return fallback;
  }
}

async function inferGroq(systemPrompt: string, userPrompt: string): Promise<AgentResponse> {
  const Groq = (await import('groq-sdk')).default;
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const completion = await client.chat.completions.create({
    model: 'qwen/qwen3-32b',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content ?? '';
  console.log('[0G Compute] Groq response received');
  return parseResponse(content);
}

async function infer0G(systemPrompt: string, userPrompt: string): Promise<AgentResponse> {
  const { ethers } = await import('ethers');
  const { createZGComputeNetworkBroker } = await import('@0glabs/0g-serving-broker');

  const privateKey = process.env.ZERO_G_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('[0G Compute] Missing required env var: ZERO_G_PRIVATE_KEY');
  }

  const rpcUrl = process.env.ZERO_G_RPC_URL || 'https://evmrpc-testnet.0g.ai';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  if (!broker) {
    broker = await createZGComputeNetworkBroker(wallet);
  }

  // Use configured provider or discover one
  let providerAddress = process.env.ZERO_G_PROVIDER_ADDRESS;
  if (!providerAddress) {
    const services = await broker.inference.listService();
    const chatService = services.find((s: Record<string, unknown>) =>
      String(s.serviceType || s.type || '').toLowerCase().includes('chat')
    );
    if (!chatService) {
      throw new Error('[0G Compute] No chat service found on 0G network');
    }
    providerAddress = (chatService as Record<string, string>).provider || (chatService as Record<string, string>).address;
  }

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const headers = await broker.inference.getRequestHeaders(providerAddress);

  const response = await fetch(`${endpoint}/v1/proxy/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const data = await response.json() as Record<string, unknown>;

  // Process response for fee settlement
  const chatID =
    response.headers.get('ZG-Res-Key') ||
    response.headers.get('zg-res-key') ||
    (data.id as string);

  if (chatID) {
    try {
      await broker.inference.processResponse(providerAddress, chatID, JSON.stringify(data.usage));
    } catch (err) {
      console.warn('[0G Compute] processResponse settlement warning:', err);
    }
  }

  const choices = data.choices as Array<{ message: { content: string } }> | undefined;
  const content = choices?.[0]?.message?.content ?? '';
  console.log('[0G Compute] 0G response received');
  return parseResponse(content);
}

// Lazy singleton for the 0G broker (SDK doesn't export a typed interface)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let broker: any = null;

export async function infer(systemPrompt: string, userPrompt: string): Promise<AgentResponse> {
  const computeProvider = process.env.COMPUTE_PROVIDER || 'groq';
  console.log(`[0G Compute] Using provider: ${computeProvider}`);

  switch (computeProvider) {
    case '0g':
      return infer0G(systemPrompt, userPrompt);
    case 'groq':
    default:
      return inferGroq(systemPrompt, userPrompt);
  }
}

export { parseResponse };
