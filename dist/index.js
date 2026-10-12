// src/index.ts
import * as readline from "node:readline";
import * as fs3 from "node:fs";
import * as path3 from "node:path";

// src/pool.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import * as os2 from "node:os";

// src/client.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
function delay(ms) {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  setTimeout(resolve2, ms);
  return promise;
}

class BravoGenClient {
  baseUrl;
  username;
  password;
  accessToken = null;
  refreshToken = null;
  tokenExpiresAt = 0;
  maxRetries;
  initialRetryDelayMs;
  maxRetryDelayMs;
  autoWaitOnRateLimit;
  maxWaitSeconds;
  isAuthenticating = null;
  tokenFilePath = null;
  cachedRateLimit = null;
  rateLimitTtlMs = 30000;
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || "https://chat.bravogen.io.vn").replace(/\/+$/, "");
    this.username = options.username || process.env.BRAVOGEN_USERNAME || "";
    this.password = options.password || process.env.BRAVOGEN_PASSWORD || "";
    this.maxRetries = options.maxRetries ?? 4;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 1e4;
    this.autoWaitOnRateLimit = options.autoWaitOnRateLimit ?? true;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 90;
    this.tokenFilePath = options.tokenFilePath || (this.username ? path.resolve(os.homedir(), ".bravogen", `.token_${this.username.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`) : null);
    this.loadTokenFromDisk();
  }
  loadTokenFromDisk() {
    if (!this.tokenFilePath || !fs.existsSync(this.tokenFilePath))
      return;
    try {
      const raw = fs.readFileSync(this.tokenFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.accessToken && parsed.tokenExpiresAt && Date.now() < parsed.tokenExpiresAt - 60000) {
        this.accessToken = String(parsed.accessToken);
        this.refreshToken = parsed.refreshToken ? String(parsed.refreshToken) : null;
        this.tokenExpiresAt = Number(parsed.tokenExpiresAt);
      }
    } catch {}
  }
  saveTokenToDisk() {
    if (!this.tokenFilePath || !this.accessToken)
      return;
    try {
      const dir = path.dirname(this.tokenFilePath);
      if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.tokenFilePath, JSON.stringify({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        tokenExpiresAt: this.tokenExpiresAt
      }), { mode: 384 });
    } catch {}
  }
  setTokens(access, refresh) {
    this.accessToken = access;
    this.refreshToken = refresh;
    this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
    this.saveTokenToDisk();
  }
  async ensureAuthenticated(forceRefresh = false) {
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
  async login() {
    try {
      const resp = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.username,
          password: this.password
        })
      });
      if (!resp.ok) {
        const errorText = await resp.text();
        console.error(`[BravoGenClient] Login failed (${resp.status}): ${errorText}`);
        return false;
      }
      const data = await resp.json();
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.tokenExpiresAt = Date.now() + 14 * 60 * 1000;
      this.saveTokenToDisk();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[BravoGenClient] Network error during login:", msg);
      return false;
    }
  }
  async tryRefreshToken() {
    if (!this.refreshToken)
      return false;
    try {
      const resp = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: this.refreshToken })
      });
      if (!resp.ok)
        return false;
      const data = await resp.json();
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
  async request(endpoint, options = {}, attempt = 0) {
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
        headers
      });
      if (resp.status === 401 && attempt < 2) {
        console.warn(`[BravoGenClient] 401 received on ${endpoint}. Initiating auto-recovery...`);
        const recovered = await this.ensureAuthenticated(true);
        if (recovered) {
          return await this.request(endpoint, options, attempt + 1);
        }
      }
      if (resp.status === 429) {
        const retryAfterHeader = resp.headers.get("retry-after");
        let waitSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 5;
        if (isNaN(waitSec) || waitSec <= 0)
          waitSec = 5;
        console.warn(`[BravoGenClient] 429 Rate limit encountered. Wait required: ${waitSec}s`);
        if (this.autoWaitOnRateLimit && waitSec <= this.maxWaitSeconds && attempt < this.maxRetries) {
          console.info(`[BravoGenClient] Auto-waiting ${waitSec}s for rate limit reset...`);
          await delay(waitSec * 1000);
          return await this.request(endpoint, options, attempt + 1);
        }
        return {
          data: null,
          status: 429,
          error: `Rate limit exceeded. Resets in ${waitSec} seconds.`,
          headers: resp.headers
        };
      }
      if ([502, 503, 504, 408].includes(resp.status) && attempt < this.maxRetries) {
        const backoffDelay = Math.min(this.maxRetryDelayMs, this.initialRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500);
        console.warn(`[BravoGenClient] Server error ${resp.status} on ${endpoint}. Retrying in ${Math.round(backoffDelay)}ms...`);
        await delay(backoffDelay);
        return await this.request(endpoint, options, attempt + 1);
      }
      if (!resp.ok) {
        const errText = await resp.text();
        return {
          data: null,
          status: resp.status,
          error: errText || `HTTP ${resp.status}`,
          headers: resp.headers
        };
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const jsonData = await resp.json();
        return { data: jsonData, status: resp.status, headers: resp.headers };
      }
      const textData = await resp.text();
      return { data: textData, status: resp.status, headers: resp.headers };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (attempt < this.maxRetries) {
        const backoffDelay = Math.min(this.maxRetryDelayMs, this.initialRetryDelayMs * Math.pow(2, attempt) + Math.random() * 500);
        console.warn(`[BravoGenClient] Network error: ${errorMsg}. Retrying in ${Math.round(backoffDelay)}ms...`);
        await delay(backoffDelay);
        return await this.request(endpoint, options, attempt + 1);
      }
      return {
        data: null,
        status: 0,
        error: `Network failure after ${attempt} retries: ${errorMsg}`,
        headers: new Headers
      };
    }
  }
  async getRateLimitStatus(force = false) {
    if (!force && this.cachedRateLimit && Date.now() < this.cachedRateLimit.expiresAt) {
      return this.cachedRateLimit.data;
    }
    const res = await this.request("/v1/rate_limit/status");
    if (!res.data || !res.data.windows)
      return null;
    const w5h = res.data.windows.find((w) => w.name === "5h");
    const w7d = res.data.windows.find((w) => w.name === "7d");
    const rem5hReq = w5h ? Math.max(0, w5h.requestLimit - w5h.requests) : 0;
    const rem5hTok = w5h ? Math.max(0, w5h.tokenLimit - w5h.tokens) : 0;
    const pct5hReq = w5h && w5h.requestLimit > 0 ? w5h.requests / w5h.requestLimit * 100 : 0;
    const rem7dReq = w7d ? Math.max(0, w7d.requestLimit - w7d.requests) : 0;
    const rem7dTok = w7d ? Math.max(0, w7d.tokenLimit - w7d.tokens) : 0;
    const pct7dReq = w7d && w7d.requestLimit > 0 ? w7d.requests / w7d.requestLimit * 100 : 0;
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
      recommendedWaitSeconds: recWait
    };
    this.cachedRateLimit = {
      data: res.data,
      expiresAt: Date.now() + this.rateLimitTtlMs
    };
    return res.data;
  }
  async getModels() {
    const res = await this.request("/v1/models");
    return res.data?.data || [];
  }
  async searchConversations(query) {
    const res = await this.request(`/v1/conversations/search?q=${encodeURIComponent(query)}`);
    return res.data?.data || [];
  }
  async listConversations(limit) {
    const q = limit ? `?limit=${limit}` : "";
    const res = await this.request(`/v1/conversations${q}`);
    return res.data?.data || [];
  }
  async getConversation(id) {
    const res = await this.request(`/v1/conversations/${encodeURIComponent(id)}`);
    return res.data;
  }
  async exportUserData() {
    const res = await this.request("/v1/me/export");
    return res.data;
  }
  async chatCompletion(prompt, options = {}) {
    const model = options.model || "bravo-insight";
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
          error: `Rate limit 5h reached (0 requests remaining). Resets at ${limitStatus.windows[0]?.resetsAt}. Please wait ${waitSec}s.`
        };
      }
    }
    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    const payload = {
      model,
      messages,
      stream: false,
      conversation_id: options.conversationId
    };
    const res = await this.request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (!res.data || !res.data.choices || res.data.choices.length === 0) {
      return {
        answer: "",
        model,
        id: "",
        error: res.error || `Completion request failed (HTTP ${res.status})`
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
      rateLimitSummary: limitSummary
    };
  }
  recordCallCompleted() {
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

// src/pool.ts
function delay2(ms) {
  const { promise, resolve: resolve3 } = Promise.withResolvers();
  setTimeout(resolve3, ms);
  return promise;
}

class AccountPool {
  accounts = [];
  defaultBaseUrl;
  autoWaitOnRateLimit;
  maxWaitSeconds;
  constructor(options = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl || "https://chat.bravogen.io.vn";
    this.autoWaitOnRateLimit = options.autoWaitOnRateLimit ?? true;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 90;
  }
  addAccount(config) {
    const client = new BravoGenClient({
      baseUrl: config.baseUrl || this.defaultBaseUrl,
      username: config.username,
      password: config.password,
      autoWaitOnRateLimit: false
    });
    const state = {
      config,
      client,
      status: "healthy",
      remaining5hRequests: 20,
      remaining7dRequests: 300,
      tokens5h: 0,
      resetsAt5h: null,
      lastChecked: 0,
      consecutiveErrors: 0,
      totalCalls: 0
    };
    this.accounts.push(state);
  }
  getAccountCount() {
    return this.accounts.length;
  }
  static loadConfig(configDir = process.cwd()) {
    const results = [];
    const packageRoot = typeof import.meta.dirname === "string" ? path2.resolve(import.meta.dirname, "..") : configDir;
    const userHome = os2.homedir();
    const candidateFiles = [
      path2.resolve(configDir, "accounts.json"),
      path2.resolve(configDir, "config.json"),
      path2.resolve(packageRoot, "accounts.json"),
      path2.resolve(userHome, ".bravogen/accounts.json"),
      path2.resolve(userHome, ".bravogen.json")
    ];
    for (const p of candidateFiles) {
      if (fs2.existsSync(p)) {
        try {
          const content = fs2.readFileSync(p, "utf-8");
          const parsed = JSON.parse(content);
          const rawList = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && ("accounts" in parsed) && Array.isArray(parsed.accounts) ? parsed.accounts : null;
          if (rawList) {
            for (let i = 0;i < rawList.length; i++) {
              const item = rawList[i];
              if (item && typeof item === "object" && "username" in item && "password" in item) {
                const u = String(item.username);
                const pwd = String(item.password);
                if (u.toUpperCase() === "YOUR_BRAVO_USERNAME" || !u.trim() || !pwd.trim())
                  continue;
                const bUrl = "baseUrl" in item ? String(item.baseUrl) : undefined;
                const id = "id" in item ? String(item.id) : `acc_${i + 1}_${u.split("@")[0]}`;
                results.push({ id, username: u, password: pwd, baseUrl: bUrl });
              }
            }
            if (results.length > 0) {
              console.error(`[AccountPool] Loaded ${results.length} account(s) from ${p}`);
              return results;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[AccountPool] Could not parse config from ${p}:`, msg);
        }
      }
    }
    const envAccounts = process.env.BRAVOGEN_ACCOUNTS;
    if (envAccounts) {
      const trimmed = envAccounts.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) {
            for (let i = 0;i < parsed.length; i++) {
              const item = parsed[i];
              if (item && typeof item === "object" && "username" in item && "password" in item) {
                results.push({
                  id: "id" in item ? String(item.id) : `env_acc_${i + 1}`,
                  username: String(item.username),
                  password: String(item.password),
                  baseUrl: "baseUrl" in item ? String(item.baseUrl) : undefined
                });
              }
            }
            if (results.length > 0)
              return results;
          }
        } catch {}
      }
      const pairs = trimmed.split(",");
      for (let i = 0;i < pairs.length; i++) {
        const parts = pairs[i].trim().split(":");
        if (parts.length >= 2) {
          const u = parts[0].trim();
          const pwd = parts.slice(1).join(":").trim();
          results.push({
            id: `acc_${i + 1}_${u.split("@")[0]}`,
            username: u,
            password: pwd
          });
        }
      }
      if (results.length > 0)
        return results;
    }
    const singleUser = process.env.BRAVOGEN_USERNAME || "";
    const singlePass = process.env.BRAVOGEN_PASSWORD || "";
    const singleBase = process.env.BRAVOGEN_BASE_URL || "https://chat.bravogen.io.vn";
    if (singleUser && singlePass) {
      results.push({
        id: "default_primary",
        username: singleUser,
        password: singlePass,
        baseUrl: singleBase
      });
    } else if (results.length === 0) {
      console.warn("[AccountPool] Warning: No accounts configured. Please populate accounts.json or set BRAVOGEN_ACCOUNTS/BRAVOGEN_USERNAME.");
    }
    return results;
  }
  async updateAccountQuota(acc, force = false) {
    try {
      const status = await acc.client.getRateLimitStatus(force);
      acc.lastChecked = Date.now();
      if (status && status.computed) {
        acc.remaining5hRequests = status.computed.remaining5hRequests;
        acc.remaining7dRequests = status.computed.remaining7dRequests;
        const w5h = status.windows.find((w) => w.name === "5h");
        acc.tokens5h = w5h?.tokens ?? 0;
        acc.resetsAt5h = w5h?.resetsAt ?? null;
        if (status.computed.isThrottled || acc.remaining5hRequests <= 0) {
          acc.status = "throttled";
        } else {
          acc.status = "healthy";
          acc.consecutiveErrors = 0;
        }
      }
    } catch {
      acc.consecutiveErrors++;
      if (acc.consecutiveErrors >= 3) {
        acc.status = "auth_error";
      }
    }
  }
  async selectBestAccount() {
    if (this.accounts.length === 0)
      return null;
    const now = Date.now();
    const staleAccounts = this.accounts.filter((a) => now - a.lastChecked > 30000);
    if (staleAccounts.length > 0) {
      await Promise.allSettled(staleAccounts.map((a) => this.updateAccountQuota(a)));
    }
    const available = this.accounts.filter((a) => a.status === "healthy" && a.remaining5hRequests > 0);
    if (available.length > 0) {
      available.sort((a, b) => {
        if (b.remaining5hRequests !== a.remaining5hRequests) {
          return b.remaining5hRequests - a.remaining5hRequests;
        }
        return a.totalCalls - b.totalCalls;
      });
      return available[0];
    }
    const resetCandidates = this.accounts.filter((a) => a.resetsAt5h && now >= new Date(a.resetsAt5h).getTime());
    if (resetCandidates.length > 0) {
      await Promise.allSettled(resetCandidates.map((a) => this.updateAccountQuota(a, true)));
      const revived = this.accounts.find((a) => a.status === "healthy" && a.remaining5hRequests > 0);
      if (revived)
        return revived;
    }
    return null;
  }
  async getActiveClient() {
    const best = await this.selectBestAccount();
    if (best)
      return best.client;
    return this.accounts[0]?.client;
  }
  async chatCompletion(prompt, options = {}) {
    const attempts = Math.min(this.accounts.length, 3);
    const triedAccounts = new Set;
    for (let i = 0;i < attempts; i++) {
      const candidate = await this.selectBestAccount();
      if (!candidate || triedAccounts.has(candidate.config.id)) {
        const untried = this.accounts.find((a) => !triedAccounts.has(a.config.id));
        if (!untried)
          break;
      }
      const activeAcc = candidate || this.accounts[0];
      triedAccounts.add(activeAcc.config.id);
      const res = await activeAcc.client.chatCompletion(prompt, options);
      if (!res.error) {
        activeAcc.totalCalls++;
        activeAcc.remaining5hRequests = Math.max(0, activeAcc.remaining5hRequests - 1);
        return {
          ...res,
          accountIdUsed: activeAcc.config.id,
          rateLimitSummary: `[Account: ${activeAcc.config.username} | 5h Quota: ${activeAcc.remaining5hRequests} reqs left | Total Pool: ${this.accounts.length} accs]`
        };
      }
      if (res.error.includes("Rate limit") || res.error.includes("429")) {
        console.warn(`[AccountPool] Account ${activeAcc.config.id} hit rate limit. Rotating to next account...`);
        activeAcc.status = "throttled";
        activeAcc.remaining5hRequests = 0;
        await this.updateAccountQuota(activeAcc);
        continue;
      }
      return {
        ...res,
        accountIdUsed: activeAcc.config.id
      };
    }
    if (this.autoWaitOnRateLimit) {
      let earliestReset = Infinity;
      let earliestAcc = null;
      for (const a of this.accounts) {
        if (a.resetsAt5h) {
          const t = new Date(a.resetsAt5h).getTime();
          if (t < earliestReset) {
            earliestReset = t;
            earliestAcc = a;
          }
        }
      }
      const waitSec = Math.max(1, Math.ceil((earliestReset - Date.now()) / 1000));
      if (earliestAcc && waitSec > 0 && waitSec <= this.maxWaitSeconds) {
        console.info(`[AccountPool] Entire pool throttled. Auto-waiting ${waitSec}s for ${earliestAcc.config.id} to reset...`);
        await delay2(waitSec * 1000);
        await this.updateAccountQuota(earliestAcc);
        const res = await earliestAcc.client.chatCompletion(prompt, options);
        return {
          ...res,
          accountIdUsed: earliestAcc.config.id
        };
      }
    }
    return {
      answer: "",
      model: options.model || "bravo-insight",
      id: "",
      accountIdUsed: "none",
      error: `All ${this.accounts.length} configured BravoGen accounts have exhausted their rate limits. Please wait for the earliest window reset.`
    };
  }
  async getPoolOverview(force = false) {
    const now = Date.now();
    const targets = this.accounts.filter((a) => force || now - a.lastChecked > 15000);
    if (targets.length > 0) {
      await Promise.allSettled(targets.map((a) => this.updateAccountQuota(a, force)));
    }
    const healthyCount = this.accounts.filter((a) => a.status === "healthy").length;
    const throttledCount = this.accounts.filter((a) => a.status === "throttled").length;
    const total5hReq = this.accounts.reduce((sum, a) => sum + a.remaining5hRequests, 0);
    const total7dReq = this.accounts.reduce((sum, a) => sum + a.remaining7dRequests, 0);
    return {
      totalAccounts: this.accounts.length,
      healthyAccounts: healthyCount,
      throttledAccounts: throttledCount,
      total5hRequestsRemaining: total5hReq,
      total7dRequestsRemaining: total7dReq,
      strategy: "quota-aware-balanced",
      accounts: this.accounts.map((a) => ({
        id: a.config.id,
        username: a.config.username,
        status: a.status,
        remaining5hRequests: a.remaining5hRequests,
        remaining7dRequests: a.remaining7dRequests,
        resetsAt5h: a.resetsAt5h,
        totalCalls: a.totalCalls
      }))
    };
  }
}

// src/index.ts
var packageRoot = typeof import.meta.dirname === "string" ? path3.resolve(import.meta.dirname, "..") : process.cwd();
var candidateKnowledgePaths = [
  path3.resolve(packageRoot, "data/bravo_knowledge.json"),
  path3.resolve(process.cwd(), "data/bravo_knowledge.json")
];
var knowledgeDbPath = candidateKnowledgePaths.find((p) => fs3.existsSync(p)) || candidateKnowledgePaths[0];
var knowledgeDb = {
  version: "1.0.0",
  total_conversations: 0,
  total_tables: 0,
  total_procedures: 0,
  total_xml_tags: 0,
  total_diagrams: 0,
  tables: {},
  procedures: {},
  xml_tags: [],
  diagrams: [],
  conversations: []
};
if (fs3.existsSync(knowledgeDbPath)) {
  try {
    const raw = fs3.readFileSync(knowledgeDbPath, "utf-8");
    knowledgeDb = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[MCP] Failed to parse ${knowledgeDbPath}:`, msg);
  }
}
var pool = new AccountPool({
  defaultBaseUrl: process.env.BRAVOGEN_BASE_URL || "https://chat.bravogen.io.vn",
  autoWaitOnRateLimit: true,
  maxWaitSeconds: 90
});
var configuredAccounts = AccountPool.loadConfig();
for (const acc of configuredAccounts) {
  pool.addAccount(acc);
}
console.error(`[MCP Server] Initialized BravoGen Account Pool with ${pool.getAccountCount()} account(s).`);
var TOOLS = [
  {
    name: "bravogen_ask_knowledge",
    description: "Hỏi đáp kỹ thuật chuyên sâu về Bravo 10 ERP, Layout XML, Stored Procedures, hạch toán kế toán, Docker Linux PostgreSQL, ISMS thông qua trợ lý Bravo Insight. Tự phục hồi phiên, tự động xoay tua đa tài khoản khi chạm hạn mức, tự retry, trả về câu trả lời và cây tư duy chi tiết (reasoning).",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Câu hỏi kỹ thuật, đoạn mã XML cần phân tích, hoặc lỗi hệ thống cần tra cứu."
        },
        model: {
          type: "string",
          enum: ["bravo-insight", "bravo-user-guide", "isms-advisor"],
          default: "bravo-insight",
          description: "Mô hình chuyên môn của BravoGen: bravo-insight (Kỹ thuật/XML/ATTT), bravo-user-guide (Hướng dẫn B10), isms-advisor (ISO 27001)."
        },
        system_prompt: {
          type: "string",
          description: "Chỉ thị bổ sung cho AI (tùy chọn)."
        },
        include_reasoning: {
          type: "boolean",
          default: true,
          description: "Có trả về nội dung suy luận logic từng bước (reasoning_content) không."
        },
        cache_first: {
          type: "boolean",
          default: false,
          description: "Nếu bật true, ưu tiên tìm kiếm câu trả lời đã có trong kho tri thức cục bộ trước để không tiêu tốn credit AI."
        }
      },
      required: ["question"]
    }
  },
  {
    name: "bravogen_pool_status",
    description: "Kiểm tra trạng thái của toàn bộ Pool tài khoản: tổng số tài khoản, số tài khoản khỏe mạnh, số tài khoản chạm hạn mức, tổng số lượt gọi còn lại trong 5h và 7d, cùng danh sách chi tiết từng tài khoản.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bravogen_rate_limit_status",
    description: "Soi limit trực tiếp: tính toán phần trăm hạn mức đã dùng, số request và tokens còn lại trong chu kỳ 5 giờ và 7 ngày của tài khoản đang hoạt động tốt nhất và tổng quan toàn pool.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "bravogen_get_knowledge_diagrams",
    description: "Lấy các biểu đồ knowledge graph, kiến trúc hệ thống và sơ đồ quy trình nghiệp vụ Bravo 10 định dạng Mermaid có sẵn để phục vụ AI coding agents.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["all", "architecture", "costing", "layout_xml", "sales", "debt_offset"],
          default: "all",
          description: "Phân loại biểu đồ cần lấy."
        },
        query: {
          type: "string",
          description: "Từ khóa tìm kiếm trong tiêu đề hoặc nội dung biểu đồ."
        }
      }
    }
  },
  {
    name: "bravogen_get_procedure_docs",
    description: "Tra cứu thông tin, vai trò nghiệp vụ và các đoạn code ngữ cảnh của các thủ tục Stored Procedures cốt lõi trong Bravo 10 (usp_*).",
    inputSchema: {
      type: "object",
      properties: {
        procedure_name: {
          type: "string",
          description: "Tên thủ tục (ví dụ: usp_B30StockLedger_Costing, usp_B30AccDoc_ApprovalVouchers, usp_Vcd_InventoryReport, usp_sys_MergeCode, ...). Để trống để lấy toàn bộ danh mục."
        }
      }
    }
  },
  {
    name: "bravogen_get_table_schema",
    description: "Tra cứu vai trò, ý nghĩa các trường dữ liệu và bối cảnh sử dụng của các bảng dữ liệu Bravo ERP (B00*, B10*, B30*).",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Tên bảng dữ liệu (ví dụ: B30StockLedger, B30AccDoc, B00FieldList, B00UserList, B00DMCT, ...). Để trống để lấy toàn bộ danh mục."
        }
      }
    }
  },
  {
    name: "bravogen_get_layout_xml_reference",
    description: "Tra cứu tài liệu và quy chuẩn khai báo Layout XML, các thẻ Evaluator (BravoEvaluator, BravoMoneyEvaluator, BravoServerConstraint, zSourceReturnMember, zDataViewSortExprFormat, ...).",
    inputSchema: {
      type: "object",
      properties: {
        tag_or_class: {
          type: "string",
          description: "Tên thẻ hoặc Class XML cần tra cứu (ví dụ: BravoMoneyEvaluator, zSourceReturnMember, ColumnChanged, BravoUniqueKeyValidator)."
        }
      }
    }
  },
  {
    name: "bravogen_search_knowledge",
    description: "Tìm kiếm toàn văn trong kho giải pháp, cấu hình XML, SQL thủ tục, và lịch sử trao đổi nội bộ BravoGen.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa tìm kiếm (ví dụ: 'giá vốn', 'Linux', 'zSourceReturnMember', 'ColumnChanged', 'gạch nợ')."
        },
        limit: {
          type: "number",
          default: 5,
          description: "Số lượng kết quả tối đa trả về."
        }
      },
      required: ["query"]
    }
  },
  {
    name: "bravogen_generate_diagram",
    description: "Yêu cầu Bravo Insight tự động vẽ biểu đồ Mermaid (Flowchart, Sequence hoặc ER Diagram) cho bất kỳ quy trình nghiệp vụ hoặc cấu trúc dữ liệu Bravo nào theo yêu cầu.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Chủ đề hoặc quy trình cần vẽ sơ đồ (ví dụ: 'Quy trình duyệt chứng từ nhiều cấp', 'Luồng dữ liệu tính giá vốn FIFO')."
        },
        diagram_type: {
          type: "string",
          enum: ["flowchart", "sequence", "er_diagram", "class_diagram"],
          default: "flowchart",
          description: "Kiểu biểu đồ Mermaid mong muốn."
        }
      },
      required: ["topic"]
    }
  },
  {
    name: "bravogen_list_conversations",
    description: "Liệt kê danh sách các cuộc hội thoại kỹ thuật hiện có trên server BravoGen.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          default: 15,
          description: "Số cuộc hội thoại tối đa cần lấy."
        }
      }
    }
  },
  {
    name: "bravogen_get_conversation",
    description: "Lấy chi tiết toàn bộ lịch sử hỏi đáp, đoạn code mẫu và suy luận trong một cuộc hội thoại theo conversation_id.",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "ID cuộc hội thoại."
        }
      },
      required: ["conversation_id"]
    }
  },
  {
    name: "bravogen_sync_knowledge",
    description: "Đồng bộ toàn bộ lịch sử hỏi đáp, đoạn code mẫu và giải pháp kỹ thuật từ server BravoGen về cơ sở dữ liệu tri thức offline cục bộ (HOÀN TOÀN KHÔNG TỐN CREDIT/QUOTA). Sau khi đồng bộ, AI agent và lập trình viên có thể tra cứu toàn văn mọi giải pháp với tốc độ tức thì mà không mất thêm lượt gọi nào.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];
var STANDARD_LAYOUT_CLASSES = {
  bravomoneyevaluator: {
    name: "BravoMoneyEvaluator",
    desc: "Class Evaluator chuyên biệt cho tính toán tiền tệ, tài chính trong Bravo 10. Hỗ trợ tự động làm tròn theo đồng tiền (zResultDecimalRound), xử lý sai số làm tròn (zResultMarginValue), tính chiết khấu nhiều mức, thuế TTĐB và công thức phối hợp số lượng * đơn giá.",
    properties: [
      "zMoneyValue: Biểu thức giá trị tiền tệ (VD: ISNULL(UnitCost,0) * ISNULL(DiscountRate,0))",
      "zNumberValue: Biểu thức giá trị số lượng hoặc tỷ lệ",
      "zFormula: Công thức phối hợp định dạng placeholder (VD: {0}/(1+{1})*{1})",
      "zResultDecimalRound: Làm tròn tiền tệ theo thiết lập loại tiền (Currency('DecimalRound'))",
      "zResultMarginValue: Ngưỡng chấp nhận sai số làm tròn",
      "DataMember: Tên cột dữ liệu đích nhận kết quả"
    ],
    example: `<Eval_DiscountAmount>
    <ClassName>BravoMoneyEvaluator</ClassName>
    <DataMember>DiscountAmount</DataMember>
    <zResultDecimalRound>Currency('DecRound_VND')</zResultDecimalRound>
    <zMoneyValue>OriginalUnitPrice - UnitPrice</zMoneyValue>
    <zNumberValue>Quantity</zNumberValue>
</Eval_DiscountAmount>`
  },
  bravoevaluator: {
    name: "BravoEvaluator",
    desc: "Bộ đánh giá biểu thức tổng quát của Bravo 10. Dùng tính toán các trường số học thông thường, biểu thức logic điều kiện (IIF, AND, OR), điều khiển ẩn hiện controls hoặc đặt giá trị mặc định.",
    properties: [
      "Expr / Value: Biểu thức toán học hoặc logic",
      "DataMember: Cột nhận giá trị tính toán",
      "Condition: Điều kiện kích hoạt",
      "ColumnChanged: Danh sách cột theo dõi thay đổi để kích hoạt Evaluator"
    ],
    example: `<Eval_TotalAmount>
    <ClassName>BravoEvaluator</ClassName>
    <DataMember>TotalAmount</DataMember>
    <Expr>Amount + TaxAmount - DiscountAmount</Expr>
</Eval_TotalAmount>`
  },
  bravoserverconstraint: {
    name: "BravoServerConstraint",
    desc: "Ràng buộc và đồng bộ dữ liệu thông qua Stored Procedure máy chủ hoặc CommandKey. Cho phép tra cứu (lookup) dữ liệu nhiều cột cùng lúc từ SQL và ánh xạ ngược về dòng chi tiết.",
    properties: [
      "CommandKey: Tên Command hoặc Stored Procedure trên server",
      "zSourceReturnMember: Chuỗi ánh xạ danh sách cột trả về (VD: ItemId=ItemId;ItemName=ItemName;Unit=Unit)",
      "Parameters: Tham số truyền vào Stored Procedure"
    ],
    example: `<Constraint_ItemLookup>
    <ClassName>BravoServerConstraint</ClassName>
    <CommandKey>usp_B10Item_Lookup</CommandKey>
    <zSourceReturnMember>ItemId=ItemId;ItemName=ItemName;Unit=Unit;UnitPrice=StandardPrice</zSourceReturnMember>
</Constraint_ItemLookup>`
  },
  bravouniquekeyvalidator: {
    name: "BravoUniqueKeyValidator",
    desc: "Bộ kiểm tra tính duy nhất (Unique) trên các dòng của lưới chi tiết, ngăn chặn người dùng nhập trùng lặp khóa chính (ví dụ trùng ItemId hoặc trùng số seri) trên cùng một chứng từ.",
    properties: [
      "DataMember: Cột cần kiểm tra duy nhất",
      "Message: Thông báo lỗi hiển thị khi phát hiện trùng"
    ],
    example: `<Val_UniqueItem>
    <ClassName>BravoUniqueKeyValidator</ClassName>
    <DataMember>ItemId</DataMember>
    <Message>Mã vật tư hàng hóa không được trùng trên các dòng chi tiết!</Message>
</Val_UniqueItem>`
  },
  bravolinkcommand: {
    name: "BravoLinkCommand",
    desc: "Lệnh liên kết dữ liệu giữa các chứng từ trong luồng nghiệp vụ (ví dụ: lấy dữ liệu từ Đơn hàng bán sang Lệnh xuất kho, từ Hóa đơn sang Phiếu thu).",
    properties: [
      "SourceDoc: Mã chứng từ nguồn",
      "TargetDoc: Mã chứng từ đích",
      "Mapping: Quy tắc map trường dữ liệu giữa 2 chứng từ"
    ],
    example: `<Cmd_LinkSaleOrder>
    <ClassName>BravoLinkCommand</ClassName>
    <SourceDoc>SO</SourceDoc>
    <TargetDoc>PX</TargetDoc>
</Cmd_LinkSaleOrder>`
  }
};
async function handleToolCall(name, args) {
  switch (name) {
    case "bravogen_ask_knowledge": {
      const question = String(args.question || "");
      const model = String(args.model || "bravo-insight");
      const systemPrompt = args.system_prompt ? String(args.system_prompt) : undefined;
      const includeReasoning = args.include_reasoning !== false;
      const cacheFirst = args.cache_first === true;
      if (cacheFirst && question) {
        const qLower = question.toLowerCase();
        for (const conv of knowledgeDb.conversations) {
          if (conv.title.toLowerCase().includes(qLower)) {
            const assistantMsg = conv.messages.find((m) => m.role === "assistant" && m.text);
            if (assistantMsg) {
              return `### [Kho Tri Thức Cục Bộ (0 Credit Tiêu Tốn - Nguồn: ${conv.title})]

${assistantMsg.text}`;
            }
          }
        }
      }
      const res = await pool.chatCompletion(question, {
        model,
        systemPrompt
      });
      if (res.error) {
        return `[LỖI BRAVOGEN] ${res.error}`;
      }
      let out = "";
      if (res.rateLimitSummary) {
        out += `${res.rateLimitSummary}

`;
      }
      if (includeReasoning && res.reasoning) {
        out += `### Suy Luận Kỹ Thuật (Reasoning):
${res.reasoning}

---

`;
      }
      out += `### Trả Lời (${res.model}):
${res.answer}`;
      return out;
    }
    case "bravogen_pool_status": {
      const overview = await pool.getPoolOverview();
      const rows = overview.accounts.map((a) => `| ${a.id} | ${a.username} | ${a.status === "healthy" ? "\uD83D\uDFE2 Khỏe mạnh" : "\uD83D\uDD34 Chạm hạn"} | ${a.remaining5hRequests}/20 | ${a.remaining7dRequests}/300 | ${a.resetsAt5h ? a.resetsAt5h.slice(11, 19) : "N/A"} | ${a.totalCalls} |`);
      return [
        `# Báo Cáo Trạng Thái Account Pool BravoGen`,
        `- Tổng số tài khoản: **${overview.totalAccounts}**`,
        `- Tài khoản sẵn sàng (Healthy): **${overview.healthyAccounts}**`,
        `- Tài khoản đang chạm hạn mức (Throttled): **${overview.throttledAccounts}**`,
        `- Tổng lượt gọi 5h còn lại toàn pool: **${overview.total5hRequestsRemaining} requests**`,
        `- Tổng lượt gọi 7d còn lại toàn pool: **${overview.total7dRequestsRemaining} requests**`,
        `- Chiến lược điều phối: **${overview.strategy}** (Ưu tiên tài khoản còn nhiều quota nhất, cân bằng tải tự động)`,
        "",
        `| ID | Tài khoản | Trạng thái | Quota 5h | Quota 7d | Reset 5h | Đã gọi |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
        ...rows
      ].join(`
`);
    }
    case "bravogen_rate_limit_status": {
      const overview = await pool.getPoolOverview();
      const activeClient = await pool.getActiveClient();
      const status = await activeClient.getRateLimitStatus();
      if (!status) {
        return "Không thể kết nối hoặc lấy trạng thái hạn mức từ server BravoGen.";
      }
      const c = status.computed;
      const w5h = status.windows.find((w) => w.name === "5h");
      const w7d = status.windows.find((w) => w.name === "7d");
      return [
        `# Báo Cáo Hạn Mức BravoGen API (Tài khoản hiện tại: ${status.userId})`,
        `- Trạng thái: ${status.enabled ? "Hoạt động bình thường" : "Bị khóa"}`,
        `- Tình trạng Throttled: ${c?.isThrottled ? "CẢNH BÁO: Hết hạn mức!" : "Bình thường (Còn hạn mức)"}`,
        "",
        `## Chu Kỳ 5 Giờ (5h Window):`,
        `- Requests: ${w5h?.requests ?? 0} / ${w5h?.requestLimit ?? 20} (Đã dùng: ${c?.pct5hRequestsUsed ?? 0}%, Còn lại: ${c?.remaining5hRequests ?? 0})`,
        `- Tokens: ${(w5h?.tokens ?? 0).toLocaleString()} / ${(w5h?.tokenLimit ?? 1500000).toLocaleString()} (Còn lại: ${(c?.remaining5hTokens ?? 0).toLocaleString()})`,
        `- Thời điểm Reset: ${w5h?.resetsAt || "N/A"}`,
        "",
        `## Chu Kỳ 7 Ngày (7d Window):`,
        `- Requests: ${w7d?.requests ?? 0} / ${w7d?.requestLimit ?? 300} (Đã dùng: ${c?.pct7dRequestsUsed ?? 0}%, Còn lại: ${c?.remaining7dRequests ?? 0})`,
        `- Tokens: ${(w7d?.tokens ?? 0).toLocaleString()} / ${(w7d?.tokenLimit ?? 20000000).toLocaleString()} (Còn lại: ${(c?.remaining7dTokens ?? 0).toLocaleString()})`,
        `- Thời điểm Reset: ${w7d?.resetsAt || "N/A"}`,
        "",
        `## Tổng Quan Account Pool:`,
        `- Tổng số tài khoản trong Pool: ${overview.totalAccounts} (Sẵn sàng: ${overview.healthyAccounts}, Hết hạn: ${overview.throttledAccounts})`,
        `- Tổng Quota 5h còn lại toàn Pool: ${overview.total5hRequestsRemaining} requests`
      ].join(`
`);
    }
    case "bravogen_get_knowledge_diagrams": {
      const category = String(args.category || "all");
      const query = args.query ? String(args.query).toLowerCase() : "";
      let list = knowledgeDb.diagrams;
      if (category !== "all") {
        list = list.filter((d) => d.id.includes(category) || d.title.toLowerCase().includes(category));
      }
      if (query) {
        list = list.filter((d) => d.title.toLowerCase().includes(query) || d.code.toLowerCase().includes(query));
      }
      if (list.length === 0) {
        return `Không tìm thấy biểu đồ nào phù hợp với bộ lọc (category: ${category}, query: ${query}).`;
      }
      return list.map((d, idx) => `### Biểu Đồ ${idx + 1}: ${d.title} (ID: ${d.id})
*Nguồn: ${d.source_conversation}*

\`\`\`mermaid
${d.code}
\`\`\``).join(`

---

`);
    }
    case "bravogen_get_procedure_docs": {
      const procName = args.procedure_name ? String(args.procedure_name).trim() : "";
      if (!procName) {
        const names = Object.keys(knowledgeDb.procedures).sort();
        return [
          `# Danh Mục Stored Procedures Bravo 10 (${names.length} thủ tục):`,
          ...names.map((n) => `- **${n}** (Số lần đề cập: ${knowledgeDb.procedures[n].mentions})`)
        ].join(`
`);
      }
      const match = knowledgeDb.procedures[procName];
      if (!match) {
        const candidates = Object.keys(knowledgeDb.procedures).filter((k) => k.toLowerCase().includes(procName.toLowerCase()));
        if (candidates.length > 0) {
          return [
            `Không tìm thấy chính xác '${procName}'. Các thủ tục tương tự:`,
            ...candidates.map((c) => `- **${c}**`)
          ].join(`
`);
        }
        return `Không tìm thấy thủ tục '${procName}' trong kho tri thức nội bộ. Bạn có thể dùng công cụ 'bravogen_ask_knowledge' để truy vấn trực tiếp mô hình AI.`;
      }
      return [
        `# Tài Liệu Thủ Tục: ${match.name}`,
        `- Tần suất xuất hiện: ${match.mentions} lần`,
        `- Ngữ cảnh & Cách sử dụng trong Bravo 10:`,
        ...match.contexts.map((ctx, idx) => `> **Trích đoạn ${idx + 1}:** ${ctx}...`)
      ].join(`

`);
    }
    case "bravogen_get_table_schema": {
      const tableName = args.table_name ? String(args.table_name).trim() : "";
      if (!tableName) {
        const names = Object.keys(knowledgeDb.tables).sort();
        return [
          `# Danh Mục Bảng Dữ Liệu Bravo ERP (${names.length} bảng):`,
          ...names.map((n) => `- **${n}** (Số lần đề cập: ${knowledgeDb.tables[n].mentions})`)
        ].join(`
`);
      }
      const match = knowledgeDb.tables[tableName];
      if (!match) {
        const candidates = Object.keys(knowledgeDb.tables).filter((k) => k.toLowerCase().includes(tableName.toLowerCase()));
        if (candidates.length > 0) {
          return [
            `Không tìm thấy chính xác '${tableName}'. Các bảng tương tự:`,
            ...candidates.map((c) => `- **${c}**`)
          ].join(`
`);
        }
        return `Không tìm thấy bảng '${tableName}' trong kho tri thức. Bạn có thể dùng 'bravogen_ask_knowledge' để hỏi trợ lý Bravo Insight.`;
      }
      return [
        `# Bảng Dữ Liệu: ${match.name}`,
        `- Tần suất xuất hiện: ${match.mentions} lần`,
        `- Ngữ cảnh nghiệp vụ & các cột thường dùng:`,
        ...match.contexts.map((ctx, idx) => `> **Trích đoạn ${idx + 1}:** ${ctx}...`)
      ].join(`

`);
    }
    case "bravogen_get_layout_xml_reference": {
      const rawInput = args.tag_or_class ? String(args.tag_or_class).trim() : "";
      const queryLower = rawInput.toLowerCase();
      const tags = knowledgeDb.xml_tags;
      if (!queryLower) {
        return [
          `# Quy Chuẩn Khai Báo Layout XML Bravo 10:`,
          `Hệ thống ghi nhận ${tags.length} thẻ XML và Class Evaluator thông dụng.`,
          `Các Class quan trọng nhất:`,
          `- **BravoEvaluator**: Xử lý tính toán công thức tổng quát, ẩn hiện điều khiển, kiểm tra biểu thức logic.`,
          `- **BravoMoneyEvaluator**: Xử lý tính toán tiền tệ và làm tròn số thập phân tự động (zResultDecimalRound).`,
          `- **BravoServerConstraint**: Ràng buộc dữ liệu qua Stored Procedure hoặc CommandKey, ánh xạ cột trả về qua zSourceReturnMember.`,
          `- **BravoUniqueKeyValidator**: Kiểm tra tính duy nhất trên các dòng lưới chi tiết (ngăn trùng ItemId).`,
          `- **BravoLinkCommand**: Liên kết lấy dữ liệu giữa các chứng từ (VD: Đơn hàng sang Hóa đơn).`,
          "",
          `Ví dụ các thẻ cấu hình tiêu biểu:`,
          tags.slice(0, 40).map((t) => `\`<${t}>\``).join(", ")
        ].join(`
`);
      }
      const matchedClassKey = Object.keys(STANDARD_LAYOUT_CLASSES).find((k) => k === queryLower || STANDARD_LAYOUT_CLASSES[k].name.toLowerCase().includes(queryLower));
      const matchedTags = tags.filter((t) => t.toLowerCase().includes(queryLower));
      const sections = [];
      if (matchedClassKey) {
        const cls = STANDARD_LAYOUT_CLASSES[matchedClassKey];
        sections.push(`# Tài Liệu Class Layout XML: ${cls.name}`, `- **Mô tả:** ${cls.desc}`, `- **Các thuộc tính cốt lõi:**
${cls.properties.map((p) => `  * \`${p.split(":")[0]}\`: ${p.split(":")[1] || ""}`).join(`
`)}`, `- **Mẫu khai báo XML chuẩn:**
\`\`\`xml
${cls.example}
\`\`\``);
      }
      if (matchedTags.length > 0) {
        sections.push(`### Thẻ XML liên quan khớp trong kho cấu hình (${matchedTags.length} thẻ):`, matchedTags.map((m) => `- \`<${m}>\``).join(`
`));
      }
      if (sections.length === 0) {
        return `Không tìm thấy thẻ XML hoặc Class Evaluator nào phù hợp với '${rawInput}'. Bạn có thể dùng 'bravogen_search_knowledge' hoặc 'bravogen_ask_knowledge' để tìm kiếm ngữ cảnh đầy đủ.`;
      }
      return sections.join(`

`);
    }
    case "bravogen_search_knowledge": {
      const q = String(args.query || "").toLowerCase();
      const limit = Number(args.limit) || 5;
      const results = [];
      for (const conv of knowledgeDb.conversations) {
        for (const msg of conv.messages) {
          if (msg.text.toLowerCase().includes(q)) {
            const preview = msg.text.slice(0, 350).replace(/\n+/g, " ");
            results.push(`### [${conv.title}] (${msg.role} - ${msg.created_at.slice(0, 10)}):
> ${preview}...
`);
            if (results.length >= limit)
              break;
          }
        }
        if (results.length >= limit)
          break;
      }
      if (results.length === 0) {
        const client = await pool.getActiveClient();
        const serverRes = await client.searchConversations(q);
        if (serverRes.length > 0) {
          return [
            `Tìm thấy ${serverRes.length} cuộc hội thoại liên quan trên server:`,
            ...serverRes.map((r) => `- **${r.title}** (ID: ${r.id}, cập nhật: ${r.updated_at})`)
          ].join(`
`);
        }
        return `Không tìm thấy kết quả nào cho '${q}'.`;
      }
      return [`# Kết Quả Tìm Kiếm Tri Thức Nội Bộ cho '${q}':`, ...results].join(`

`);
    }
    case "bravogen_generate_diagram": {
      const topic = String(args.topic || "");
      const diagramType = String(args.diagram_type || "flowchart");
      const prompt = [
        `Hãy thiết kế một biểu đồ Mermaid chuẩn (loại: ${diagramType}) mô tả chi tiết cho chủ đề sau trong hệ thống BRAVO 10:`,
        `Chủ đề: "${topic}"`,
        `Yêu cầu:`,
        `1. Biểu đồ phải thể hiện chính xác các thực thể, bảng dữ liệu (B00/B10/B30), thủ tục stored procedure (nếu có), hoặc luồng người dùng/hệ thống.`,
        `2. Đặt toàn bộ biểu đồ trong một khối \`\`\`mermaid duy nhất, cú pháp hợp lệ 100%.`,
        `3. Kèm theo phần giải thích ngắn gọn bằng tiếng Việt bên dưới.`
      ].join(`
`);
      const res = await pool.chatCompletion(prompt, {
        model: "bravo-insight"
      });
      if (res.error) {
        return `[LỖI TẠO BIỂU ĐỒ] ${res.error}`;
      }
      return res.answer;
    }
    case "bravogen_list_conversations": {
      const limit = Number(args.limit) || 15;
      const client = await pool.getActiveClient();
      const convs = await client.listConversations(limit);
      if (convs.length === 0) {
        return "Không có cuộc hội thoại nào hoặc không thể lấy danh sách từ server.";
      }
      return [
        `# Danh Sách Cuộc Hội Thoại Trên BravoGen (${convs.length} mục):`,
        ...convs.map((c, idx) => `${idx + 1}. **${c.title}**
   - ID: \`${c.id}\`
   - Model: ${c.model || "bravo-insight"}
   - Cập nhật: ${c.updated_at}`)
      ].join(`
`);
    }
    case "bravogen_get_conversation": {
      const cid = String(args.conversation_id || "");
      const client = await pool.getActiveClient();
      const conv = await client.getConversation(cid);
      if (!conv) {
        return `Không tìm thấy cuộc hội thoại với ID: ${cid}`;
      }
      const msgs = conv.messages || [];
      return [
        `# Chi Tiết Hội Thoại: ${conv.title} (ID: ${conv.id})`,
        `- Tổng số tin nhắn: ${msgs.length}`,
        "",
        ...msgs.map((m, idx) => `### [Tin nhắn ${idx + 1}] Role: ${m.role.toUpperCase()} (${m.created_at})
${m.reasoning ? `*Suy luận:*
> ${m.reasoning.slice(0, 300)}...

` : ""}${m.text || ""}`)
      ].join(`

---

`);
    }
    case "bravogen_sync_knowledge": {
      const client = await pool.getActiveClient();
      const exportData = await client.exportUserData();
      if (!exportData || !exportData.conversations) {
        return "Không thể xuất dữ liệu từ server BravoGen. Vui lòng kiểm tra lại kết nối mạng hoặc token đăng nhập.";
      }
      let newCount = 0;
      let updatedCount = 0;
      const existingMap = new Map(knowledgeDb.conversations.map((c) => [c.id, c]));
      for (const conv of exportData.conversations) {
        const mappedMessages = conv.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text || "",
          has_reasoning: Boolean(m.reasoning),
          created_at: m.created_at
        }));
        const convItem = {
          id: conv.id,
          title: conv.title,
          model: conv.model,
          message_count: mappedMessages.length,
          messages: mappedMessages
        };
        if (existingMap.has(conv.id)) {
          existingMap.set(conv.id, convItem);
          updatedCount++;
        } else {
          existingMap.set(conv.id, convItem);
          newCount++;
        }
      }
      knowledgeDb.conversations = Array.from(existingMap.values());
      knowledgeDb.total_conversations = knowledgeDb.conversations.length;
      try {
        fs3.writeFileSync(knowledgeDbPath, JSON.stringify(knowledgeDb, null, 2), "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Sync] Could not persist to ${knowledgeDbPath}:`, msg);
      }
      const totalMsgs = knowledgeDb.conversations.reduce((sum, c) => sum + c.messages.length, 0);
      return [
        `# Đồng Bộ Tri Thức BravoGen Thành Công (0 Credit Tiêu Tốn)`,
        `- Số cuộc hội thoại mới thêm: **${newCount}**`,
        `- Số cuộc hội thoại cập nhật: **${updatedCount}**`,
        `- Tổng số cuộc hội thoại trong kho offline: **${knowledgeDb.total_conversations}**`,
        `- Tổng số tin nhắn kỹ thuật offline: **${totalMsgs}**`,
        "",
        `Toàn bộ tri thức đã được nạp vào bộ nhớ cục bộ. Giờ đây bạn có thể dùng 'bravogen_search_knowledge' hoặc 'bravogen_ask_knowledge' (với cache_first) để tra cứu mọi giải pháp với tốc độ < 5ms mà không tiêu tốn thêm bất kỳ credit nào.`
      ].join(`
`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
var rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed)
    return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    const errorResp = {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32700, message: "Parse error" }
    };
    process.stdout.write(JSON.stringify(errorResp) + `
`);
    return;
  }
  const { id, method, params } = req;
  try {
    switch (method) {
      case "initialize": {
        const resp = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: {}
            },
            serverInfo: {
              name: "bravogen-mcp",
              version: "1.0.0"
            }
          }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
      case "notifications/initialized": {
        break;
      }
      case "tools/list": {
        const resp = {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
      case "tools/call": {
        const toolName = String(params?.name || "");
        const toolArgs = params?.arguments || {};
        const textResult = await handleToolCall(toolName, toolArgs);
        const resp = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: textResult
              }
            ]
          }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
      case "resources/list": {
        const resp = {
          jsonrpc: "2.0",
          id,
          result: {
            resources: [
              {
                uri: "bravo://diagrams",
                name: "Bravo Knowledge Graph & Mermaid Diagrams",
                mimeType: "application/json"
              },
              {
                uri: "bravo://procedures",
                name: "Bravo Stored Procedures Reference",
                mimeType: "application/json"
              },
              {
                uri: "bravo://tables",
                name: "Bravo Database Tables Catalog",
                mimeType: "application/json"
              }
            ]
          }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
      case "resources/read": {
        const uri = String(params?.uri || "");
        let textContent = "";
        if (uri === "bravo://diagrams") {
          textContent = JSON.stringify(knowledgeDb.diagrams, null, 2);
        } else if (uri === "bravo://procedures") {
          textContent = JSON.stringify(knowledgeDb.procedures, null, 2);
        } else if (uri === "bravo://tables") {
          textContent = JSON.stringify(knowledgeDb.tables, null, 2);
        } else {
          const resp2 = {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Resource not found: ${uri}` }
          };
          process.stdout.write(JSON.stringify(resp2) + `
`);
          return;
        }
        const resp = {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: textContent
              }
            ]
          }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
      default: {
        const resp = {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        };
        process.stdout.write(JSON.stringify(resp) + `
`);
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp = {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `Internal error: ${msg}` }
    };
    process.stdout.write(JSON.stringify(resp) + `
`);
  }
});
