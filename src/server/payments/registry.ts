import "server-only";
import { env } from "@/server/env";
import { loadCryptomusConfig, CRYPTOMUS_ID } from "./cryptomus/config";
import { CryptomusPaymentProvider } from "./cryptomus/provider";
import { ManualPaymentProvider } from "./manual/manual-provider";
import type { PaymentProvider } from "./types";

/**
 * Top-up providers. Several can be offered side by side:
 *  - "manual" (PAYMENT_PROVIDER=manual, default): Easypaisa / JazzCash sent
 *    by the customer and approved by an administrator;
 *  - "cryptomus": automatic crypto payments, configured and switched on in
 *    Admin → Settings → Payments (credentials stored encrypted).
 * The top-up page and the payment service only use this abstraction.
 *
 * `listPaymentProviders` = what customers can choose now (enabled ones).
 * `findPaymentProvider` also returns a configured provider that an admin has
 * DISABLED, so payments created earlier still settle (webhooks, polling).
 */

/** Tests only: when set, the providers are exactly [override] (null = none). */
let override: PaymentProvider | null | undefined;

const manual = new ManualPaymentProvider();

async function cryptomus(opts: { includeDisabled: boolean }): Promise<{ provider: PaymentProvider; sortOrder: number } | null> {
  const config = await loadCryptomusConfig();
  if (!config.configured || (!config.enabled && !opts.includeDisabled)) return null;
  return { provider: new CryptomusPaymentProvider(config, env().CRYPTOMUS_API_URL), sortOrder: config.sortOrder };
}

export async function listPaymentProviders(): Promise<PaymentProvider[]> {
  if (override !== undefined) return override ? [override] : [];
  const list: { provider: PaymentProvider; sortOrder: number }[] = [];
  if (env().PAYMENT_PROVIDER === "manual") list.push({ provider: manual, sortOrder: 0 });
  const c = await cryptomus({ includeDisabled: false });
  if (c) list.push(c);
  return list.sort((a, b) => a.sortOrder - b.sortOrder).map((x) => x.provider);
}

export async function findPaymentProvider(id: string): Promise<PaymentProvider | null> {
  if (override !== undefined) return override && override.id === id ? override : null;
  if (id === manual.id) return manual;
  if (id === CRYPTOMUS_ID) return (await cryptomus({ includeDisabled: true }))?.provider ?? null;
  return null;
}

export function setPaymentProviderForTesting(provider: PaymentProvider | null | undefined) {
  override = provider;
}
