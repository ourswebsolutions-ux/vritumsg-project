import "server-only";
import { env } from "@/server/env";
import { decryptSecret, maskSecret } from "@/server/security/secrets";
import { getSetting, type CryptomusSetting } from "@/server/services/settings.service";

/**
 * Effective Cryptomus configuration. Credentials saved in the admin panel
 * (encrypted) take priority; the CRYPTOMUS_* environment variables are only
 * a fallback for the first deployment. Plain credentials exist only inside
 * the server process — use `cryptomusAdminView` for anything shown.
 */

export type CredentialSource = "admin" | "env" | null;

export type CryptomusConfig = CryptomusSetting & {
  merchantIdPlain: string | null;
  paymentKeyPlain: string | null;
  payoutKeyPlain: string | null;
  sources: { merchantId: CredentialSource; paymentKey: CredentialSource; payoutKey: CredentialSource };
  /** A saved credential couldn't be decrypted (SETTINGS_ENCRYPTION_KEY missing or changed). */
  decryptError: boolean;
  /** Merchant UUID + Payment API key are available: invoices and webhooks can work. */
  configured: boolean;
  /** Offered to customers: enabled by an admin AND configured. */
  active: boolean;
  /** The URL Cryptomus posts payment notifications to. */
  effectiveWebhookUrl: string;
};

export const CRYPTOMUS_ID = "cryptomus";
export const CRYPTOMUS_METHOD = "crypto";

export function defaultWebhookUrl(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/payments/webhook/${CRYPTOMUS_ID}`;
}

export async function loadCryptomusConfig(): Promise<CryptomusConfig> {
  const s = await getSetting("payment_cryptomus");
  const e = env();
  let decryptError = false;
  const pick = (stored: string | null, fallback: string | undefined): [string | null, CredentialSource] => {
    if (stored) {
      const plain = decryptSecret(stored);
      if (plain) return [plain, "admin"];
      decryptError = true;
      return [null, null];
    }
    return fallback ? [fallback, "env"] : [null, null];
  };
  const [merchantIdPlain, m] = pick(s.merchantId, e.CRYPTOMUS_MERCHANT_ID);
  const [paymentKeyPlain, p] = pick(s.paymentKey, e.CRYPTOMUS_PAYMENT_API_KEY);
  const [payoutKeyPlain, o] = pick(s.payoutKey, e.CRYPTOMUS_PAYOUT_API_KEY);
  const configured = Boolean(merchantIdPlain && paymentKeyPlain);
  return {
    ...s,
    merchantIdPlain,
    paymentKeyPlain,
    payoutKeyPlain,
    sources: { merchantId: m, paymentKey: p, payoutKey: o },
    decryptError,
    configured,
    active: s.enabled && configured,
    effectiveWebhookUrl: s.webhookUrl ?? e.CRYPTOMUS_WEBHOOK_URL ?? defaultWebhookUrl(),
  };
}

/** What the admin panel may see: settings and MASKED credentials only. */
export type CryptomusAdminView = Omit<CryptomusConfig, "merchantIdPlain" | "paymentKeyPlain" | "payoutKeyPlain" | "merchantId" | "paymentKey" | "payoutKey"> & {
  masked: { merchantId: string | null; paymentKey: string | null; payoutKey: string | null };
};

export async function cryptomusAdminView(): Promise<CryptomusAdminView> {
  const c = await loadCryptomusConfig();
  const { merchantIdPlain, paymentKeyPlain, payoutKeyPlain, merchantId: _m, paymentKey: _p, payoutKey: _o, ...rest } = c;
  return { ...rest, masked: { merchantId: maskSecret(merchantIdPlain), paymentKey: maskSecret(paymentKeyPlain), payoutKey: maskSecret(payoutKeyPlain) } };
}
