import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BravoGenClient } from "./client.js";
import type { RateLimitStatus } from "./types.js";

export interface AccountConfig {
  id: string;
  username: string;
  password: string;
  baseUrl?: string;
}

export interface AccountState {
  config: AccountConfig;
  client: BravoGenClient;
  status: "healthy" | "throttled" | "auth_error" | "recovering";
  remaining5hRequests: number;
  remaining7dRequests: number;
  tokens5h: number;
  resetsAt5h: string | null;
  lastChecked: number;
  consecutiveErrors: number;
  totalCalls: number;
}

export interface PoolOverview {
  totalAccounts: number;
  healthyAccounts: number;
  throttledAccounts: number;
  total5hRequestsRemaining: number;
  total7dRequestsRemaining: number;
  strategy: string;
  accounts: Array<{
    id: string;
    username: string;
    status: string;
    remaining5hRequests: number;
    remaining7dRequests: number;
    resetsAt5h: string | null;
    totalCalls: number;
  }>;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class AccountPool {
  private accounts: AccountState[] = [];
  private defaultBaseUrl: string;
  private autoWaitOnRateLimit: boolean;
  private maxWaitSeconds: number;

  constructor(options: {
    defaultBaseUrl?: string;
    autoWaitOnRateLimit?: boolean;
    maxWaitSeconds?: number;
  } = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl || "https://chat.bravogen.io.vn";
    this.autoWaitOnRateLimit = options.autoWaitOnRateLimit ?? true;
    this.maxWaitSeconds = options.maxWaitSeconds ?? 90;
  }

  public addAccount(config: AccountConfig): void {
    const client = new BravoGenClient({
      baseUrl: config.baseUrl || this.defaultBaseUrl,
      username: config.username,
      password: config.password,
      autoWaitOnRateLimit: false, // Pool handles rotation before waiting
    });

    const state: AccountState = {
      config,
      client,
      status: "healthy",
      remaining5hRequests: 20,
      remaining7dRequests: 300,
      tokens5h: 0,
      resetsAt5h: null,
      lastChecked: 0,
      consecutiveErrors: 0,
      totalCalls: 0,
    };

    this.accounts.push(state);
  }

  public getAccountCount(): number {
    return this.accounts.length;
  }

  /**
   * Parse accounts from configuration sources:
   * 1. accounts.json in cwd, package root, or ~/.bravogen/
   * 2. BRAVOGEN_ACCOUNTS environment variable
   * 3. Fallback to BRAVOGEN_USERNAME / BRAVOGEN_PASSWORD
   */
  public static loadConfig(configDir: string = process.cwd()): AccountConfig[] {
    const results: AccountConfig[] = [];
    const packageRoot = typeof import.meta.dirname === "string" 
      ? path.resolve(import.meta.dirname, "..") 
      : configDir;
    const userHome = os.homedir();

    const candidateFiles = [
      path.resolve(configDir, "accounts.json"),
      path.resolve(configDir, "config.json"),
      path.resolve(packageRoot, "accounts.json"),
      path.resolve(userHome, ".bravogen/accounts.json"),
      path.resolve(userHome, ".bravogen.json"),
    ];

    for (const p of candidateFiles) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = JSON.parse(content) as unknown;
          const rawList = Array.isArray(parsed)
            ? parsed
            : parsed && typeof parsed === "object" && "accounts" in parsed && Array.isArray(parsed.accounts)
              ? parsed.accounts
              : null;

          if (rawList) {
            for (let i = 0; i < rawList.length; i++) {
              const item = rawList[i];
              if (item && typeof item === "object" && "username" in item && "password" in item) {
                const u = String(item.username);
                const pwd = String(item.password);
                if (u.toUpperCase() === "YOUR_BRAVO_USERNAME" || !u.trim() || !pwd.trim()) continue;
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[AccountPool] Could not parse config from ${p}:`, msg);
        }
      }
    }

    // Source 2: BRAVOGEN_ACCOUNTS environment variable
    const envAccounts = process.env.BRAVOGEN_ACCOUNTS;
    if (envAccounts) {
      const trimmed = envAccounts.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) {
            for (let i = 0; i < parsed.length; i++) {
              const item = parsed[i];
              if (item && typeof item === "object" && "username" in item && "password" in item) {
                results.push({
                  id: "id" in item ? String(item.id) : `env_acc_${i + 1}`,
                  username: String(item.username),
                  password: String(item.password),
                  baseUrl: "baseUrl" in item ? String(item.baseUrl) : undefined,
                });
              }
            }
            if (results.length > 0) return results;
          }
        } catch {
          // Fall through
        }
      }

      const pairs = trimmed.split(",");
      for (let i = 0; i < pairs.length; i++) {
        const parts = pairs[i].trim().split(":");
        if (parts.length >= 2) {
          const u = parts[0].trim();
          const pwd = parts.slice(1).join(":").trim();
          results.push({
            id: `acc_${i + 1}_${u.split("@")[0]}`,
            username: u,
            password: pwd,
          });
        }
      }
      if (results.length > 0) return results;
    }

    // Source 3: Single account fallback
    const singleUser = process.env.BRAVOGEN_USERNAME || "";
    const singlePass = process.env.BRAVOGEN_PASSWORD || "";
    const singleBase = process.env.BRAVOGEN_BASE_URL || "https://chat.bravogen.io.vn";

    if (singleUser && singlePass) {
      results.push({
        id: "default_primary",
        username: singleUser,
        password: singlePass,
        baseUrl: singleBase,
      });
    } else if (results.length === 0) {
      console.warn("[AccountPool] Warning: No accounts configured. Please populate accounts.json or set BRAVOGEN_ACCOUNTS/BRAVOGEN_USERNAME.");
    }

    return results;
  }

  public async updateAccountQuota(acc: AccountState, force: boolean = false): Promise<void> {
    try {
      const status: RateLimitStatus | null = await acc.client.getRateLimitStatus(force);
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

  public async selectBestAccount(): Promise<AccountState | null> {
    if (this.accounts.length === 0) return null;

    const now = Date.now();
    const staleAccounts = this.accounts.filter((a) => now - a.lastChecked > 30000);
    if (staleAccounts.length > 0) {
      await Promise.allSettled(staleAccounts.map((a) => this.updateAccountQuota(a)));
    }

    const available = this.accounts.filter(
      (a) => a.status === "healthy" && a.remaining5hRequests > 0
    );

    if (available.length > 0) {
      available.sort((a, b) => {
        if (b.remaining5hRequests !== a.remaining5hRequests) {
          return b.remaining5hRequests - a.remaining5hRequests;
        }
        return a.totalCalls - b.totalCalls;
      });
      return available[0];
    }

    const resetCandidates = this.accounts.filter(
      (a) => a.resetsAt5h && now >= new Date(a.resetsAt5h).getTime()
    );
    if (resetCandidates.length > 0) {
      await Promise.allSettled(resetCandidates.map((a) => this.updateAccountQuota(a, true)));
      const revived = this.accounts.find(
        (a) => a.status === "healthy" && a.remaining5hRequests > 0
      );
      if (revived) return revived;
    }

    return null;
  }

  public async getActiveClient(): Promise<BravoGenClient> {
    const best = await this.selectBestAccount();
    if (best) return best.client;
    return this.accounts[0]?.client;
  }

  public async chatCompletion(
    prompt: string,
    options: {
      model?: string;
      systemPrompt?: string;
      conversationId?: string;
    } = {}
  ): Promise<{
    answer: string;
    reasoning?: string;
    model: string;
    id: string;
    rateLimitSummary?: string;
    accountIdUsed: string;
    error?: string;
  }> {
    const attempts = Math.min(this.accounts.length, 3);
    const triedAccounts = new Set<string>();

    for (let i = 0; i < attempts; i++) {
      const candidate = await this.selectBestAccount();
      if (!candidate || triedAccounts.has(candidate.config.id)) {
        const untried = this.accounts.find((a) => !triedAccounts.has(a.config.id));
        if (!untried) break;
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
          rateLimitSummary: `[Account: ${activeAcc.config.username} | 5h Quota: ${activeAcc.remaining5hRequests} reqs left | Total Pool: ${this.accounts.length} accs]`,
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
        accountIdUsed: activeAcc.config.id,
      };
    }

    if (this.autoWaitOnRateLimit) {
      let earliestReset = Infinity;
      let earliestAcc: AccountState | null = null;
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
        await delay(waitSec * 1000);
        await this.updateAccountQuota(earliestAcc);
        const res = await earliestAcc.client.chatCompletion(prompt, options);
        return {
          ...res,
          accountIdUsed: earliestAcc.config.id,
        };
      }
    }

    return {
      answer: "",
      model: options.model || "bravo-insight",
      id: "",
      accountIdUsed: "none",
      error: `All ${this.accounts.length} configured BravoGen accounts have exhausted their rate limits. Please wait for the earliest window reset.`,
    };
  }

  public async getPoolOverview(force: boolean = false): Promise<PoolOverview> {
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
        totalCalls: a.totalCalls,
      })),
    };
  }
}
