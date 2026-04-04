export interface ParameterSchema {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
}

export interface Action {
  name: string;
  description: string;
  parameters: ParameterSchema[];
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface Provider {
  name: string;
  description: string;
  handler: () => Promise<string>;
}

export interface AgentContext {
  providerResults: Record<string, string>;
  timestamp: string;
}

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  actions: Action[];
  providers: Provider[];
}

export interface AgentResponse {
  action: string | null;
  args: Record<string, unknown>;
  reasoning: string;
}
