// Lightweight HTTP uptime probe: status + latency for the caption.
// Independent of the screenshot path so an uptime signal still goes out even if
// rendering fails.

export interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

export async function probeHost(host: string, timeoutMs = 15_000): Promise<ProbeResult> {
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  const start = Date.now();
  if (typeof fetchImpl !== "function") {
    return { ok: false, latencyMs: 0, error: "global fetch unavailable" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(host, { method: "GET", redirect: "follow", signal: controller.signal });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - start, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}
