import { AgentResponse } from '../../types/agents';

// ── Runtime provider switching ──────────────────────────────────────
let currentProvider = process.env.COMPUTE_PROVIDER || 'groq';

export function setComputeProvider(provider: 'groq' | '0g'): void {
  currentProvider = provider;
  console.log(`[0G Compute] Provider switched to: ${provider}`);
}

export function getComputeProvider(): string {
  return currentProvider;
}

// ── Response parsing ────────────────────────────────────────────────
function parseResponse(raw: string): AgentResponse {
  const fallback: AgentResponse = {
    action: null,
    args: {},
    reasoning: 'Failed to parse LLM response',
  };

  try {
    let cleaned = raw.trim();

    // Strip <think>...</think> blocks (Qwen3 thinking mode)
    // Handle closed tags first, then unclosed <think> that runs to end of string
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');
    cleaned = cleaned.replace(/<think>[\s\S]*/g, '');
    cleaned = cleaned.trim();

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

    console.log('[0G Compute] Cleaned response for parsing:', cleaned.slice(0, 500));

    // Try direct parse first
    try {
      const parsed = JSON.parse(cleaned);
      return {
        action: parsed.action ?? null,
        args: parsed.args ?? {},
        reasoning: parsed.reasoning ?? '',
      };
    } catch {
      // Fall through to extraction
    }

    // Extract first { to last } from cleaned string
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate);
        return {
          action: parsed.action ?? null,
          args: parsed.args ?? {},
          reasoning: parsed.reasoning ?? '',
        };
      } catch {
        // Fall through to balanced brace extraction
      }
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

    console.warn('[0G Compute] Could not extract JSON from LLM response, using fallback');
    return fallback;
  } catch (err) {
    console.warn('[0G Compute] parseResponse error:', err);
    return fallback;
  }
}

// ── Groq inference ──────────────────────────────────────────────────
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
  console.log('[0G Compute] Groq raw response:', content.slice(0, 500));
  return parseResponse(content);
}

// ── 0G Compute inference (API key approach) ─────────────────────────
// Uses the 0G Compute marketplace API key for authentication.
// Simpler and avoids ESM/CJS broker SDK import issues in tsx runtime.
// Fee settlement happens automatically on the provider side.

const ZERO_G_DEFAULT_URL = 'https://compute-network-6.integratenetwork.work/v1/proxy';
const ZERO_G_DEFAULT_MODEL = 'qwen/qwen-2.5-7b-instruct';

async function infer0G(systemPrompt: string, userPrompt: string): Promise<AgentResponse> {
  const apiKey = process.env.ZERO_G_API_KEY;
  if (!apiKey) {
    throw new Error('[0G Compute] Missing required env var: ZERO_G_API_KEY');
  }

  const serviceUrl = process.env.ZERO_G_SERVICE_URL || ZERO_G_DEFAULT_URL;
  const model = process.env.ZERO_G_MODEL || ZERO_G_DEFAULT_MODEL;

  console.log(`[0G Compute] Endpoint: ${serviceUrl}`);
  console.log(`[0G Compute] Model: ${model}`);

  const response = await fetch(`${serviceUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
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

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`[0G Compute] Inference request failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as Record<string, unknown>;

  const choices = data.choices as Array<{ message: { content: string } }> | undefined;
  const content = choices?.[0]?.message?.content ?? '';
  console.log('[0G Compute] 0G raw response:', content.slice(0, 500));

  return parseResponse(content);
}

// ── Main inference export ───────────────────────────────────────────
export async function infer(systemPrompt: string, userPrompt: string): Promise<AgentResponse> {
  console.log(`[0G Compute] Using provider: ${currentProvider}`);

  switch (currentProvider) {
    case '0g':
      return infer0G(systemPrompt, userPrompt);
    case 'groq':
    default:
      return inferGroq(systemPrompt, userPrompt);
  }
}

export { parseResponse };
