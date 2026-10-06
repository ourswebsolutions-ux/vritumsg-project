import "server-only";
import { toMinor } from "@/lib/money";
import { env } from "@/server/env";
import { cryptomusAdminView, defaultWebhookUrl, loadCryptomusConfig, type CryptomusAdminView } from "@/server/payments/cryptomus/config";
import { CryptomusPaymentProvider } from "@/server/payments/cryptomus/provider";
import { PaymentProviderError } from "@/server/payments/types";
import { canEncryptSecrets, encryptSecret } from "@/server/security/secrets";
import { platformCurrency } from "@/server/services/currency";
import { getSetting, saveSetting, type CryptomusSetting } from "@/server/services/settings.service";
import { audit } from "./audit";
import type { AdminActor } from "./guard";
import type { AdminResult } from "./users";

/**
 * Admin → Settings → Payments → Cryptomus. Credentials are write-only: the
 * panel receives masked hints, a blank field keeps the saved value, and new
 * values are encrypted before they are stored. Nothing here returns, logs or
 * audits a plain credential.
 */

export type CryptomusSettingsView = CryptomusAdminView & {
  canEncrypt: boolean;
  defaultWebhookUrl: string;
  currency: string;
  /** TRUST_PROXY is needed for the IP check behind a reverse proxy. */
  trustProxy: boolean;
  lastTest: { at: string; ok: boolean; services: number } | null;
};

export async function getCryptomusSettings(): Promise<CryptomusSettingsView> {
  return {
    ...(await cryptomusAdminView()),
    canEncrypt: canEncryptSecrets(),
    defaultWebhookUrl: defaultWebhookUrl(),
    currency: platformCurrency().code,
    trustProxy: env().TRUST_PROXY,
    lastTest,
  };
}

/** A credential field: a new value, "keep" (blank) or "clear". */
export type SecretInput = { value: string; clear: boolean };

export type CryptomusSettingsInput = {
  enabled: boolean;
  merchantId: SecretInput;
  paymentKey: SecretInput;
  payoutKey: SecretInput;
  displayName: string;
  description: string;
  minAmount: string;
  maxAmount: string;
  feeFixed: string;
  feePercent: string;
  sortOrder: string;
  webhookUrl: string;
  verifyIp: boolean;
  lifetimeMinutes: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_KEY = /^[A-Za-z0-9+/=_-]{16,512}$/;
const MONEY = /^\d{1,7}(\.\d{1,4})?$/;

const LABEL = { merchantId: "Merchant UUID", paymentKey: "Payment API key", payoutKey: "Payout API key" } as const;
type SecretName = keyof typeof LABEL;

function checkSecret(name: SecretName, value: string): string | null {
  if (name === "merchantId") return UUID.test(value) ? null : "The Merchant UUID looks like 8-4-4-4-12 hexadecimal characters (Cryptomus → Settings → Merchant).";
  return API_KEY.test(value) ? null : `The ${LABEL[name]} doesn't look right — paste it exactly as shown in Cryptomus (no spaces).`;
}

const clean = (v: string) => v.trim().replace(",", ".");
const short = (v: string) => (/^\d+(\.\d+)?$/.test(v) ? String(Number(v)) : v);

export async function saveCryptomusSettings(actor: AdminActor, input: CryptomusSettingsInput): Promise<AdminResult> {
  const before = await getSetting("payment_cryptomus");

  // Credentials: blank keeps the saved value, "clear" removes it, anything else replaces it.
  const next: Pick<CryptomusSetting, SecretName> = { merchantId: before.merchantId, paymentKey: before.paymentKey, payoutKey: before.payoutKey };
  const changed: string[] = [];
  for (const name of Object.keys(LABEL) as SecretName[]) {
    const { value, clear } = input[name];
    const v = value.trim();
    if (v) {
      const problem = checkSecret(name, v);
      if (problem) return { ok: false, message: problem };
      if (!canEncryptSecrets()) {
        return { ok: false, message: "Set SETTINGS_ENCRYPTION_KEY on the server (openssl rand -base64 32) before saving credentials here. Nothing was saved." };
      }
      next[name] = encryptSecret(v);
      changed.push(`${name}:replaced`);
    } else if (clear && before[name]) {
      next[name] = null;
      changed.push(`${name}:cleared`);
    }
  }

  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 60) return { ok: false, message: "Enter a display name (2–60 characters)." };
  const description = input.description.trim();
  if (description.length > 200) return { ok: false, message: "Keep the description under 200 characters." };

  const [minAmount, maxAmount, feeFixed] = [clean(input.minAmount), clean(input.maxAmount), clean(input.feeFixed || "0")];
  for (const [label, v] of [["Minimum amount", minAmount], ["Maximum amount", maxAmount], ["Fixed fee", feeFixed]] as const) {
    if (!MONEY.test(v)) return { ok: false, message: `${label}: enter a number like 10 or 2.50.` };
  }
  if (toMinor(minAmount) < toMinor("1")) return { ok: false, message: "The minimum amount must be at least 1." };
  if (toMinor(maxAmount) < toMinor(minAmount)) return { ok: false, message: "The maximum amount must be at least the minimum amount." };
  const feePercent = clean(input.feePercent || "0");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(feePercent)) return { ok: false, message: "Percentage fee: enter 0–99.99, e.g. 1.5." };

  const sortOrder = Number(input.sortOrder.trim() || "10");
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100) return { ok: false, message: "Sort order: a whole number from 0 to 100 (Manual is 0)." };
  const lifetimeMinutes = Number(input.lifetimeMinutes.trim() || "60");
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 5 || lifetimeMinutes > 720) {
    return { ok: false, message: "Invoice lifetime: 5 to 720 minutes (Cryptomus allows 5 minutes to 12 hours)." };
  }

  let webhookUrl: string | null = input.webhookUrl.trim() || null;
  if (webhookUrl) {
    let u: URL;
    try {
      u = new URL(webhookUrl);
    } catch {
      return { ok: false, message: "Enter the webhook URL as a full https:// address, or leave it empty for the default." };
    }
    if (u.protocol !== "https:" && env().NODE_ENV === "production") return { ok: false, message: "The webhook URL must use https://." };
    if (webhookUrl.length < 6 || webhookUrl.length > 255) return { ok: false, message: "The webhook URL must be 6–255 characters." };
    if (webhookUrl === defaultWebhookUrl()) webhookUrl = null;
  }

  const value: CryptomusSetting = {
    ...next,
    enabled: input.enabled,
    displayName,
    description,
    minAmount: short(minAmount),
    maxAmount: short(maxAmount),
    feeFixed: short(feeFixed),
    feePercent: short(feePercent),
    sortOrder,
    webhookUrl,
    verifyIp: input.verifyIp,
    lifetimeMinutes,
  };

  // Enabling needs a Merchant UUID and Payment API key (saved here or in the environment).
  const e = env();
  if (value.enabled && !((value.merchantId || e.CRYPTOMUS_MERCHANT_ID) && (value.paymentKey || e.CRYPTOMUS_PAYMENT_API_KEY))) {
    return { ok: false, message: "Add the Merchant UUID and Payment API key before enabling Cryptomus." };
  }

  await saveSetting("payment_cryptomus", value);
  // Audit: settings and WHICH credentials changed — never their values.
  const { merchantId: _a, paymentKey: _b, payoutKey: _c, ...publicBefore } = before;
  const { merchantId: _d, paymentKey: _e, payoutKey: _f, ...publicAfter } = value;
  await audit(
    actor,
    "payment_cryptomus.update",
    { type: "setting", id: "payment_cryptomus" },
    true,
    { before: publicBefore, after: publicAfter, credentials: changed },
    `Cryptomus settings saved (${value.enabled ? "enabled" : "disabled"}${changed.length ? `; ${changed.join(", ")}` : ""})`,
  );
  const after = await loadCryptomusConfig();
  if (after.decryptError) return { ok: false, message: "Saved, but a stored credential can't be decrypted (SETTINGS_ENCRYPTION_KEY changed?). Enter it again." };
  return { ok: true, message: value.enabled ? "Cryptomus settings saved. Crypto top-ups are available to customers." : "Cryptomus settings saved. Crypto top-ups are hidden from customers." };
}

/* ------------------------------------------------------ test connection -- */

/** Last test result in this process (shown in the status panel; no credentials). */
let lastTest: { at: string; ok: boolean; services: number } | null = null;

/**
 * Signs a read-only request (list of payment services) with the Merchant UUID
 * and Payment API key — the values typed in the form if any, else the saved
 * ones. Answers with a fixed message; provider details stay in the log.
 */
export async function testCryptomusConnection(actor: AdminActor, typed: { merchantId?: string; paymentKey?: string } = {}): Promise<AdminResult> {
  const saved = await loadCryptomusConfig();
  const merchantId = typed.merchantId?.trim() || saved.merchantIdPlain;
  const paymentKey = typed.paymentKey?.trim() || saved.paymentKeyPlain;
  const FAILED = "Cryptomus connection failed. Please verify Merchant ID/API key.";
  if (!merchantId || !paymentKey) return { ok: false, message: "Enter the Merchant UUID and Payment API key first." };

  let ok = false;
  let count = 0;
  let reason = "";
  try {
    const provider = new CryptomusPaymentProvider({ ...saved, merchantIdPlain: merchantId, paymentKeyPlain: paymentKey }, env().CRYPTOMUS_API_URL);
    const services = await provider.listServices();
    count = Array.isArray(services) ? services.filter((s) => s.is_available !== false).length : 0;
    ok = true;
  } catch (error) {
    reason = error instanceof PaymentProviderError ? error.code : "error";
  }
  lastTest = { at: new Date().toISOString(), ok, services: count };
  await audit(actor, "payment_cryptomus.test", { type: "setting", id: "payment_cryptomus" }, ok, ok ? { services: count } : { reason }, ok ? "Cryptomus connection test passed" : `Cryptomus connection test failed (${reason})`);
  if (!ok) return { ok: false, message: reason === "TIMEOUT" || reason === "UNAVAILABLE" ? "Cryptomus connection failed: the API couldn't be reached. Try again shortly." : FAILED };
  return { ok: true, message: `Cryptomus connection successful.${count ? ` ${count} payment options available.` : ""}` };
}
