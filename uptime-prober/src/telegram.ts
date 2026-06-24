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
}

export async function sendPhoto(input: SendPhotoInput): Promise<void> {
  const g = globalThis as TelegramGlobals;
  if (!g.fetch || !g.FormData || !g.Blob) {
    throw new Error("telegram sendPhoto needs global fetch + FormData + Blob");
  }
  const form = new g.FormData();
  form.append("chat_id", input.chatId);
  if (input.caption) form.append("caption", input.caption);
  // Uint8Array view keeps the bytes intact through Blob.
  form.append("photo", new g.Blob([new Uint8Array(input.png)], { type: "image/png" }), "screenshot.png");

  const res = await g.fetch(`${TELEGRAM_API}/bot${input.botToken}/sendPhoto`, { method: "POST", body: form });
  await assertOk(res, "sendPhoto");
}

export interface SendMessageInput {
  botToken: string;
  chatId: string;
  text: string;
}

export async function sendMessage(input: SendMessageInput): Promise<void> {
  const fetchImpl = (globalThis as TelegramGlobals).fetch;
  if (!fetchImpl) throw new Error("telegram sendMessage needs global fetch");
  const res = await fetchImpl(`${TELEGRAM_API}/bot${input.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: input.chatId, text: input.text })
  });
  await assertOk(res, "sendMessage");
}

export function formatCaption(host: string, probe: ProbeResult, atMs: number): string {
  const when = new Date(atMs).toISOString();
  if (probe.ok) {
    return `✅ ${host}\nHTTP ${probe.status} · ${probe.latencyMs}ms\n${when}`;
  }
  const detail = probe.status ? `HTTP ${probe.status}` : (probe.error ?? "unreachable");
  return `⚠️ ${host}\n${detail} · ${probe.latencyMs}ms\n${when}`;
}

async function assertOk(res: { ok: boolean; status: number; text(): Promise<string> }, op: string): Promise<void> {
  if (res.ok) return;
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  throw new Error(`telegram ${op} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
}
