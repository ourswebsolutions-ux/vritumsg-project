import "server-only";
import { PaymentProviderError, type PaymentErrorCode } from "../types";
import { signBody } from "./signature";

/**
 * Minimal Cryptomus Merchant API client (https://api.cryptomus.com).
 * Every call is POST with a JSON body signed by `signBody`, and the headers
 * `merchant` (merchant UUID) and `sign`. Successful answers are
 * `{ state: 0, result }`. Errors become PaymentProviderError with a SAFE
 * message (provider message / field names only — never keys or signatures).
 *
 * The Payment API key and the Payout API key are different credentials
 * (Cryptomus requires that); a client is bound to exactly one of them.
 */

const TIMEOUT_MS = 15_000;

export type CryptomusClientOptions = { baseUrl: string; merchantId: string; apiKey: string };

/** Short, non-sensitive description of a Cryptomus error answer, for logs and the admin panel. */
function safeMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "no details";
  const b = body as { message?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof b.message === "string") parts.push(b.message);
  if (b.errors && typeof b.errors === "object") {
    for (const [field, msgs] of Object.entries(b.errors as Record<string, unknown>)) {
      parts.push(`${field}: ${Array.isArray(msgs) ? msgs.filter((m) => typeof m === "string").join(", ") : String(msgs)}`);
    }
  }
  return (parts.join("; ") || "no details").replace(/\s+/g, " ").slice(0, 200);
}

export class CryptomusClient {
  constructor(private readonly opts: CryptomusClientOptions) {}

  async post<T>(path: string, payload: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", merchant: this.opts.merchantId, sign: signBody(body, this.opts.apiKey) },
        body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new PaymentProviderError(aborted ? "TIMEOUT" : "UNAVAILABLE", aborted ? "Cryptomus did not answer in time" : "Cryptomus could not be reached", "cryptomus");
    } finally {
      clearTimeout(timer);
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const state = json && typeof json === "object" ? (json as { state?: unknown }).state : undefined;
    if (res.ok && state === 0) return (json as { result: T }).result;

    const message = safeMessage(json);
    let code: PaymentErrorCode;
    if (res.status === 401 || res.status === 403) code = "NOT_CONFIGURED";
    else if (res.status === 429) code = "RATE_LIMITED";
    else if (res.status >= 500) code = "UNAVAILABLE";
    else if (/not\s*found/i.test(message) || res.status === 404) code = "NOT_FOUND";
    else code = "BAD_REQUEST";
    throw new PaymentProviderError(code, `Cryptomus ${path} failed (HTTP ${res.status}): ${message}`, "cryptomus");
  }
}
