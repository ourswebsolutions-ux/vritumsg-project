import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Cryptomus request/webhook signatures (doc.cryptomus.com → Request format,
 * Webhook):  sign = md5( base64( json ) + API_KEY ).
 *
 * Outgoing requests sign the exact JSON string that is sent. Webhooks are
 * signed by Cryptomus (PHP) over json_encode($data, JSON_UNESCAPED_UNICODE)
 * of the payload WITHOUT its "sign" field: forward slashes escaped as "\/",
 * other Unicode left as-is (U+2028/2029 still escaped) — reproduced here.
 */

export const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export function signBody(body: string, apiKey: string): string {
  return md5(Buffer.from(body, "utf8").toString("base64") + apiKey);
}

/** PHP json_encode($v, JSON_UNESCAPED_UNICODE) for JSON-decoded data (same key order). */
export function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, "\\/").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const equalHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Parses a webhook body and checks its signature with the PAYMENT API key.
 * Returns the payload (without "sign") or null when the body isn't a signed
 * JSON object or the signature doesn't match. Never throws on bad input.
 */
export function verifyWebhookSignature(rawBody: string, paymentApiKey: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { sign, ...rest } = data as Record<string, unknown>;
  if (typeof sign !== "string" || !/^[0-9a-f]{32}$/i.test(sign)) return null;
  const expected = md5(Buffer.from(phpJsonEncode(rest), "utf8").toString("base64") + paymentApiKey);
  return equalHex(expected, sign.toLowerCase()) ? rest : null;
}
