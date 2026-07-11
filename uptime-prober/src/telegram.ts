// Telegram delivery via the user's OWN bot (user-supplied bot_token + chat_id).
//
// sendPhoto requires a multipart/form-data upload of the PNG bytes — so this needs
// global fetch + FormData + Blob. Whether the Acurast runtime provides binary
// multipart egress (vs only the httpPOST string shim) is the third capability the
// spike validates (./capabilities.ts). No PROOF bot, no chat_id discovery: the
// user does BotFather + /start once and supplies both values.

import type { ProbeResult } from "./probe.js";

const TELEGRAM_API = "https://api.telegram.org";

interface TelegramGlobals {
  fetch?: typeof fetch;
  FormData?: typeof FormData;
  Blob?: typeof Blob;
}

export function telegramMultipartAvailable(): boolean {
  const g = globalThis as TelegramGlobals;
  return typeof g.fetch === "function" && typeof g.FormData === "function" && typeof g.Blob === "function";
}

export interface SendPhotoInput {
  botToken: string;
  chatId: string;
  png: Buffer;
  caption?: string;
  timeoutMs?: number;
}

export interface TelegramReceipt {
  operation: "sendPhoto" | "sendMessage";
  messageId: number;
  caption?: string;
  chatType?: string;
  photo?: { fileId: string; width: number; height: number };
}

export async function sendPhoto(input: SendPhotoInput): Promise<TelegramReceipt> {
  const g = globalThis as TelegramGlobals;
  if (!g.fetch || !g.FormData || !g.Blob) {
    throw new Error("telegram sendPhoto needs global fetch + FormData + Blob");
  }
  const form = new g.FormData();
  form.append("chat_id", input.chatId);
  if (input.caption) form.append("caption", input.caption);
  // Uint8Array view keeps the bytes intact through Blob.
  form.append("photo", new g.Blob([new Uint8Array(input.png)], { type: "image/png" }), "screenshot.png");

  return telegramRequest(g.fetch, input.botToken, "sendPhoto", { method: "POST", body: form }, input.timeoutMs);
}

export interface SendMessageInput {
  botToken: string;
  chatId: string;
  text: string;
  timeoutMs?: number;
}

export async function sendMessage(input: SendMessageInput): Promise<TelegramReceipt> {
  const fetchImpl = (globalThis as TelegramGlobals).fetch;
  if (!fetchImpl) throw new Error("telegram sendMessage needs global fetch");
  return telegramRequest(fetchImpl, input.botToken, "sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: input.chatId, text: input.text })
  }, input.timeoutMs);
}

export function formatCaption(host: string, probe: ProbeResult, atMs: number): string {
  const when = new Date(atMs).toISOString();
  if (probe.ok) {
    return `✅ ${host}\nHTTP ${probe.status} · ${probe.latencyMs}ms\n${when}`;
  }
  const detail = probe.status ? `HTTP ${probe.status}` : (probe.error ?? "unreachable");
  return `⚠️ ${host}\n${detail} · ${probe.latencyMs}ms\n${when}`;
}

async function telegramRequest(
  fetchImpl: typeof fetch,
  botToken: string,
  operation: TelegramReceipt["operation"],
  init: RequestInit,
  timeoutMs = 20_000
): Promise<TelegramReceipt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${botToken}/${operation}`, { ...init, signal: controller.signal });
  } catch (error) {
    throw new Error(`telegram ${operation} transport failed: ${JSON.stringify(safeTransportError(error))}`);
  } finally {
    clearTimeout(timer);
  }
  let decoded: unknown;
  try { decoded = await res.json(); } catch { decoded = undefined; }
  const response = decoded as { ok?: boolean; description?: string; error_code?: number; result?: Record<string, unknown> } | undefined;
  if (!res.ok || response?.ok !== true || !response.result) {
    const description = typeof response?.description === "string" ? response.description.slice(0, 200) : undefined;
    throw new Error(`telegram ${operation} failed: ${JSON.stringify({ status: res.status, errorCode: response?.error_code, description })}`);
  }
  const result = response.result;
  const photos = Array.isArray(result.photo) ? result.photo as Array<Record<string, unknown>> : [];
  const photo = [...photos].sort((a, b) => Number(b.width ?? 0) * Number(b.height ?? 0) - Number(a.width ?? 0) * Number(a.height ?? 0))[0];
  return {
    operation,
    messageId: Number(result.message_id),
    caption: typeof result.caption === "string" ? result.caption : undefined,
    chatType: typeof (result.chat as Record<string, unknown> | undefined)?.type === "string" ? String((result.chat as Record<string, unknown>).type) : undefined,
    photo: photo && typeof photo.file_id === "string" ? { fileId: photo.file_id, width: Number(photo.width), height: Number(photo.height) } : undefined
  };
}

export function safeTransportError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  const cause = error.cause as { code?: unknown } | undefined;
  return {
    name: error.name,
    message: error.name === "AbortError" ? "request timed out" : error.message.replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gu, "https://api.telegram.org/bot[redacted]"),
    causeCode: typeof cause?.code === "string" && /^[A-Z0-9_]+$/u.test(cause.code) ? cause.code : undefined
  };
}
