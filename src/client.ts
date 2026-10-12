import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  UserProfile,
  RateLimitStatus,
  ModelInfo,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from "./types.js";

export interface ClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  tokenFilePath?: string;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  autoWaitOnRateLimit?: boolean;
  maxWaitSeconds?: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  updated_at: string;
}

export interface ConversationDetail {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  messages: Array<{
    id: string;
    parent_id?: string;
    role: string;
    text?: string;
    reasoning?: string;
    created_at: string;
    is_error?: boolean;
    is_canceled?: boolean;
  }>;
}
export interface ExportUserDataResponse {
  user?: UserProfile;
  exported_at?: string;
  scope?: string;
  conversations: Array<{
    id: string;
    title: string;
    model: string;
    created_at: string;
    messages: Array<{
      id: string;
      role: string;
      text?: string;
      reasoning?: string;
      created_at: string;
      is_error?: boolean;
      is_canceled?: boolean;
    }>;
  }>;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class BravoGenClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private maxRetries: number;
  private initialRetryDelayMs: number;
  private maxRetryDelayMs: number;
  private autoWaitOnRateLimit: boolean;
  private maxWaitSeconds: number;
  private isAuthenticating: Promise<boolean> | null = null;
  private tokenFilePath: string | null = null;
  private cachedRateLimit: { data: RateLimitStatus; expiresAt: number } | null = null;
  private rateLimitTtlMs: number = 30000;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl || "https://chat.bravogen.io.vn").replace(/\/+$/, "");
    this.username = options.username || process.env.BRAVOGEN_USERNAME || "";
    this.password = options.password || process.env.BRAVOGEN_PASSWORD || "";
    this.maxRetries = options.maxRetries ?? 4;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 10000;
    this.autoWaitOnRateLimit = options.autoWaitOnRateLimit ?? true;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 90;
    this.tokenFilePath =
      options.tokenFilePath ||
      (this.username
        ? path.resolve(os.homedir(), ".bravogen", `.token_${this.username.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
        : null);
    this.loadTokenFromDisk();
  }

  private loadTokenFromDisk(): void {
    if (!this.tokenFilePath || !fs.existsSync(this.tokenFilePath)) return;
    try {
      const raw = fs.readFileSync(this.tokenFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.accessToken && parsed.tokenExpiresAt && Date.now() < parsed.tokenExpiresAt - 60000) {
        this.accessToken = String(parsed.accessToken);
        this.refreshToken = parsed.refreshToken ? String(parsed.refreshToken) : null;
        this.tokenExpiresAt = Number(parsed.tokenExpiresAt);
      }
    } catch {
      // Fall back to login
    }
  }

  private saveTokenToDisk(): void {
    if (!this.tokenFilePath || !this.accessToken) return;
    try {
      const dir = path.dirname(this.tokenFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.tokenFilePath,
        JSON.stringify({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          tokenExpiresAt: this.tokenExpiresAt,
        }),
        { mode: 0o600 }
      );
    } catch {
      // Non-fatal
    }
  }

  public setTokens(access: string, refresh: string): void {
    this.accessToken = access;
    this.refreshToken = refresh;
    this.tokenExpiresAt = Date.now() + 14 * 60 * 1000; // ~14 min
    this.saveTokenToDisk();
  }

  /**
   * Self-healing authentication with concurrency protection
   */
  public async ensureAuthenticated(forceRefresh: boolean = false): Promise<boolean> {
    if (!forceRefresh && this.accessToken && Date.now() < this.tokenExpiresAt) {
      return true;
    }

    if (this.isAuthenticating) {
      return await this.isAuthenticating;
    }

    this.isAuthenticating = (async () => {
      try {
        if (this.refreshToken) {
          const refreshed = await this.tryRefreshToken();
          if (refreshed) {
            return true;
          }
        }
        return await this.login();
      } finally {
        this.isAuthenticating = null;
      }
    })();

    return await this.isAuthenticating;
  }

  /**
   * Authenticate via POST /api/auth/login
   */
  public async login(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`[BravoGenClient] Login failed (${resp.status}): ${errorText}`);
        return false;
      }

      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        user: UserProfile;
      };

      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
      this.saveTokenToDisk();
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[BravoGenClient] Network error during login:", msg);
      return false;
    }
  }

  /**
   * Refresh token via POST /api/auth/refresh
   */
  private async tryRefreshToken(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const resp = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });

      if (!resp.ok) return false;

      const data = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
      };

      this.accessToken = data.access_token;
      if (data.refresh_token) {
        this.refreshToken = data.refresh_token;
      }
      this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
      this.saveTokenToDisk();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resilient request wrapper with retry, rate limit wait, and auto-recovery
   */
  public async request<T>(
    endpoint: string,
    options: RequestInit = {},
    attempt: number = 0
  ): Promise<{ data: T | null; status: number; error?: string; headers: Headers }> {
    await this.ensureAuthenticated();

    const url = endpoint.startsWith("http") ? endpoint : `${this.baseUrl}${endpoint}`;
    const headers = new Headers(options.headers || {});
    if (this.accessToken) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }
    if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    try {
      const resp = await fetch(url, {
        ...options,
        headers,
      });

      // Handle 401 Unauthorized -> Trigger Auto-recovery
      if (resp.status === 401 && attempt < 2) {
        console.warn(`[BravoGenClient] 401 received on ${endpoint}. Initiating auto-recovery...`);
        const recovered = await this.ensureAuthenticated(true);
        if (recovered) {
          return await this.request<T>(endpoint, options, attempt + 1);
        }
      }

      // Handle 429 Too Many Requests -> Rate limit wait
      if (resp.status === 429) {
        const retryAfterHeader = resp.headers.get("retry-after");
        let waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 5;
        if (isNaN(waitSec) || waitSec <= 0) waitSec = 5;

        console.warn(`[BravoGenClient] 429 Rate limit encountered. Wait required: ${waitSec}s`);

        if (this.autoWaitOnRateLimit && waitSec <= this.maxWaitSeconds && attempt < this.maxRetries) {
          console.info(`[BravoGenClient] Auto-waiting ${waitSec}s for rate limit reset...`);
          await delay(waitSec * 1000);
          return await this.request<T>(endpoint, options, attempt + 1);
        }

        return {
          data: null,
          status: 429,
          error: `Rate limit exceeded. Resets in ${waitSec} seconds.`,
          headers: resp.headers,
        };
      }

      // Handle transient server errors (502, 503, 504) -> Exponential Backoff Retry
      if ([502, 503, 504, 408].includes(resp.status) && attempt < this.maxRetries) {
        const backoffDelay = Math.min(
          this.maxRetryDelayMs,
          this.initialRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500
        );
        console.warn(`[BravoGenClient] Server error ${resp.status} on ${endpoint}. Retrying in ${Math.round(backoffDelay)}ms...`);
        await delay(backoffDelay);
        return await this.request<T>(endpoint, options, attempt + 1);
      }

      if (!resp.ok) {
        const errText = await resp.text();
        return {
          data: null,
          status: resp.status,
          error: errText || `HTTP ${resp.status}`,
          headers: resp.headers,
        };
      }

      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const jsonData = (await resp.json()) as T;
        return { data: jsonData, status: resp.status, headers: resp.headers };
      }

      // Non-json response
      const textData = (await resp.text()) as unknown as T;
      return { data: textData, status: resp.status, headers: resp.headers };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempt < this.maxRetries) {
        const backoffDelay = Math.min(
          this.maxRetryDelayMs,
          this.initialRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500
        );
        console.warn(`[BravoGenClient] Network error: ${errorMsg}. Retrying in ${Math.round(backoffDelay)}ms...`);
        await delay(backoffDelay);
        return await this.request<T>(endpoint, options, attempt + 1);
      }

      return {
        data: null,
        status: 0,
        error: `Network failure after ${attempt} retries: ${errorMsg}`,
        headers: new Headers(),
      };
    }
  }

  /**
   * "Soi limit" - Inspect live rate limits with full mathematical calculations
   */
  public async getRateLimitStatus(force: boolean = false): Promise<RateLimitStatus | null> {
    if (!force && this.cachedRateLimit && Date.now() < this.cachedRateLimit.expiresAt) {
      return this.cachedRateLimit.data;
    }

    const res = await this.request<RateLimitStatus>("/v1/rate_limit/status");
    if (!res.data || !res.data.windows) return null;

    const w5h = res.data.windows.find((w) => w.name === "5h");
    const w7d = res.data.windows.find((w) => w.name === "7d");

    const rem5hReq = w5h ? Math.max(0, w5h.requestLimit - w5h.requests) : 0;
    const rem5hTok = w5h ? Math.max(0, w5h.tokenLimit - w5h.tokens) : 0;
    const pct5hReq = w5h && w5h.requestLimit > 0 ? (w5h.requests / w5h.requestLimit) * 100 : 0;

    const rem7dReq = w7d ? Math.max(0, w7d.requestLimit - w7d.requests) : 0;
    const rem7dTok = w7d ? Math.max(0, w7d.tokenLimit - w7d.tokens) : 0;
    const pct7dReq = w7d && w7d.requestLimit > 0 ? (w7d.requests / w7d.requestLimit) * 100 : 0;

    const isThrottled = rem5hReq <= 0 || rem7dReq <= 0;
    let recWait = 0;
    if (rem5hReq <= 0 && w5h?.resetsAt) {
      const resetTime = new Date(w5h.resetsAt).getTime();
      recWait = Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    }

    res.data.computed = {
      remaining5hRequests: rem5hReq,
      remaining5hTokens: rem5hTok,
      pct5hRequestsUsed: Math.round(pct5hReq * 10) / 10,
      remaining7dRequests: rem7dReq,
      remaining7dTokens: rem7dTok,
      pct7dRequestsUsed: Math.round(pct7dReq * 10) / 10,
      isThrottled,
      recommendedWaitSeconds: recWait,
    };

    this.cachedRateLimit = {
      data: res.data,
      expiresAt: Date.now() + this.rateLimitTtlMs,
    };

    return res.data;
  }

  public async getModels(): Promise<ModelInfo[]> {
    const res = await this.request<{ data: ModelInfo[] }>("/v1/models");
    return res.data?.data || [];
  }

  public async searchConversations(query: string): Promise<ConversationSummary[]> {
    const res = await this.request<{ data: ConversationSummary[] }>(
      `/v1/conversations/search?q=${encodeURIComponent(query)}`
    );
    return res.data?.data || [];
  }

  public async listConversations(limit?: number): Promise<ConversationSummary[]> {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.request<{ data: ConversationSummary[] }>(`/v1/conversations${q}`);
    return res.data?.data || [];
  }

  public async getConversation(id: string): Promise<ConversationDetail | null> {
    const res = await this.request<ConversationDetail>(`/v1/conversations/${encodeURIComponent(id)}`);
    return res.data;
  }
  public async exportUserData(): Promise<ExportUserDataResponse | null> {
    const res = await this.request<ExportUserDataResponse>("/v1/me/export");
    return res.data;
  }

  /**
   * Execute chat completion with model selection, auto-recovery & limit guard
   */
  public async chatCompletion(
    prompt: string,
    options: {
      model?: "bravo-insight" | "bravo-user-guide" | "isms-advisor" | string;
      systemPrompt?: string;
      conversationId?: string;
    } = {}
  ): Promise<{
    answer: string;
    reasoning?: string;
    model: string;
    id: string;
    rateLimitSummary?: string;
    error?: string;
  }> {
    const model = options.model || "bravo-insight";

    // Pre-flight check: "soi limit" before dispatching
    const limitStatus = await this.getRateLimitStatus();
    if (limitStatus?.computed?.isThrottled) {
      const waitSec = limitStatus.computed.recommendedWaitSeconds;
      if (this.autoWaitOnRateLimit && waitSec > 0 && waitSec <= this.maxWaitSeconds) {
        console.info(`[BravoGenClient] Limit exhausted. Auto-waiting ${waitSec}s until window reset...`);
        await delay(waitSec * 1000);
      } else if (limitStatus.computed.remaining5hRequests <= 0) {
        return {
          answer: "",
          model,
          id: "",
          error: `Rate limit 5h reached (0 requests remaining). Resets at ${limitStatus.windows[0]?.resetsAt}. Please wait ${waitSec}s.`,
        };
      }
    }

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system" as const, content: options.systemPrompt });
    }
    messages.push({ role: "user" as const, content: prompt });

    const payload: ChatCompletionRequest = {
      model,
      messages,
      stream: false,
      conversation_id: options.conversationId,
    };

    const res = await this.request<ChatCompletionResponse>("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!res.data || !res.data.choices || res.data.choices.length === 0) {
      return {
        answer: "",
        model,
        id: "",
        error: res.error || `Completion request failed (HTTP ${res.status})`,
      };
    }

    const choice = res.data.choices[0];
    const answer = choice.message?.content || "";
    const reasoning = choice.message?.reasoning_content;

    let limitSummary = "";
    if (limitStatus?.computed) {
      limitSummary = `[Quota: 5h: ${limitStatus.computed.remaining5hRequests} reqs left, 7d: ${limitStatus.computed.remaining7dRequests} reqs left]`;
    }

    this.recordCallCompleted();

    return {
      answer,
      reasoning,
      model: res.data.model || model,
      id: res.data.id,
      rateLimitSummary: limitSummary,
    };
  }
  public recordCallCompleted(): void {
    if (this.cachedRateLimit?.data.computed) {
      const c = this.cachedRateLimit.data.computed;
      c.remaining5hRequests = Math.max(0, c.remaining5hRequests - 1);
      c.remaining7dRequests = Math.max(0, c.remaining7dRequests - 1);
      if (c.remaining5hRequests <= 0 || c.remaining7dRequests <= 0) {
        c.isThrottled = true;
      }
    }
  }
}
