export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  provider: string;
  is_admin: boolean;
  role: string;
}

export interface RateLimitWindow {
  name: string;
  tokens: number;
  tokenLimit: number;
  requests: number;
  requestLimit: number;
  resetsAt: string | null;
}

export interface RateLimitStatus {
  userId: string;
  enabled: boolean;
  windows: RateLimitWindow[];
  computed?: {
    remaining5hRequests: number;
    remaining5hTokens: number;
    pct5hRequestsUsed: number;
    remaining7dRequests: number;
    remaining7dTokens: number;
    pct7dRequestsUsed: number;
    isThrottled: boolean;
    recommendedWaitSeconds: number;
  };
}

export interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  display_name: string;
  description: string;
  icon?: string;
  capabilities: {
    context_window: number;
    max_output_tokens: number;
    structured_output: boolean;
    tool_calling: boolean;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  conversation_id?: string;
  parent_message_id?: string;
  user_message_client_id?: string;
  assistant_message_client_id?: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content: string;
    reasoning_content?: string;
  };
  finish_reason?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
}

export interface KnowledgeDiagram {
  id: string;
  title: string;
  source_conversation: string;
  type: "mermaid";
  code: string;
}

export interface StoredProcedureDoc {
  name: string;
  mentions: number;
  contexts: string[];
}

export interface TableDoc {
  name: string;
  mentions: number;
  contexts: string[];
}

export interface KnowledgeDatabase {
  version: string;
  total_conversations: number;
  total_tables: number;
  total_procedures: number;
  total_xml_tags: number;
  total_diagrams: number;
  tables: Record<string, TableDoc>;
  procedures: Record<string, StoredProcedureDoc>;
  xml_tags: string[];
  diagrams: KnowledgeDiagram[];
  conversations: Array<{
    id: string;
    title: string;
    model: string;
    message_count: number;
    messages: Array<{
      id: string;
      role: string;
      text: string;
      has_reasoning: boolean;
      created_at: string;
    }>;
  }>;
}
