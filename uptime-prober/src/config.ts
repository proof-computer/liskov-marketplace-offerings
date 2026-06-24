// Configuration surface for the offering.
//
// Marketplace mapping (BKLG-20260624-002): host + chatId are USER config; the
// bot token is a USER secret-option delivered via Lockbox (installed into env).
// There is NO provider secret for this offering.

export const ENV = {
  /** User config: URL to probe + screenshot. */
  host: "UPTIME_PROBER_HOST",
  /** User config: the user's numeric Telegram chat id (after they /start their bot). */
  chatId: "UPTIME_PROBER_TG_CHAT_ID",
  /** User secret-option: the user's own bot token (Lockbox -> env). */
  botToken: "UPTIME_PROBER_TG_BOT_TOKEN",
  /** "run" (default) | "spike" (capability probe only, no loop). */
  mode: "UPTIME_PROBER_MODE",
  /** Fixed 5-minute tick; overridable for local/dev runs. */
  tickMs: "UPTIME_PROBER_TICK_MS",
  /** Page settle time before capture. */
  settleMs: "UPTIME_PROBER_SETTLE_MS"
} as const;

export const DEFAULT_TICK_MS = 300_000; // 5 minutes (fixed)
export const DEFAULT_SETTLE_MS = 8_000;

export type EnvGetter = (name: string) => string | undefined;

export interface ProberConfig {
  host: string;
  chatId: string;
  mode: "run" | "spike";
  tickMs: number;
  settleMs: number;
}

export interface ConfigIssue {
  field: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: ProberConfig }
  | { ok: false; issues: ConfigIssue[] };

/** Read non-secret config. The bot token is read separately, after Lockbox readiness. */
export function readConfig(get: EnvGetter): ConfigResult {
  const issues: ConfigIssue[] = [];
  const host = nonEmpty(get(ENV.host));
  const chatId = nonEmpty(get(ENV.chatId));

  if (!host) issues.push({ field: ENV.host, message: "required (e.g. https://example.com)" });
  else if (!/^https?:\/\//i.test(host)) issues.push({ field: ENV.host, message: "must be an http(s) URL" });
  if (!chatId) issues.push({ field: ENV.chatId, message: "required (your numeric Telegram chat id)" });

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    config: {
      host: host as string,
      chatId: chatId as string,
      mode: get(ENV.mode) === "spike" ? "spike" : "run",
      tickMs: positiveInt(get(ENV.tickMs), DEFAULT_TICK_MS),
      settleMs: positiveInt(get(ENV.settleMs), DEFAULT_SETTLE_MS)
    }
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
