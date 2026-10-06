import "server-only";
import { z } from "zod";
import { db, type Prisma } from "@/server/db";
import { siteConfig } from "@/config/site";
import { env } from "@/server/env";

/**
 * Platform settings that admins change at runtime (stored in `settings`).
 * Plain secrets never live here: the only credentials (Cryptomus) are stored
 * encrypted with SETTINGS_ENCRYPTION_KEY, which itself stays in the environment.
 * Reads are cached briefly per process; saving refreshes this process at once.
 */

const MaintenanceSchema = z.object({ enabled: z.boolean(), message: z.string().max(300) });
/** Manual Easypaisa / JazzCash top-ups: where customers send money, and who to contact. */
const ManualPaymentSchema = z.object({
  accountName: z.string().trim().min(2).max(80),
  accountNumber: z.string().trim().regex(/^\+?[\d\s-]{7,20}$/),
  whatsapp: z.string().trim().max(20).nullable(),
  note: z.string().max(200).default(""),
});
const PricingSchema = z.object({
  markupPercent: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
  minMargin: z.string().regex(/^\d{1,6}(\.\d{1,4})?$/),
});

/**
 * Conversion tax / markup per display currency, in units of that currency,
 * ADDED TO THE EXCHANGE RATE (1 USD = base + markup). Display only — never
 * changes a stored price or a charge. "0" = the plain exchange rate.
 */
const markup = z.string().regex(/^\d{1,6}(\.\d{1,4})?$/);
const CurrencyMarkupSchema = z.object({ PKR: markup, INR: markup, BDT: markup });

/** The one global chatbot subscription: when it was last activated and when it lapses (ISO, server time). */
const ChatbotSubscriptionSchema = z.object({ activatedAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime().nullable() });

/**
 * Cryptomus crypto top-ups (Admin → Settings → Payments). The three
 * credentials are stored ENCRYPTED ("v1:…", see server/security/secrets.ts),
 * null = not set here (the CRYPTOMUS_* environment fallback applies).
 */
const money4 = z.string().regex(/^\d{1,7}(\.\d{1,4})?$/);
const enc = z.string().startsWith("v1:").max(2000).nullable();
const CryptomusSchema = z.object({
  enabled: z.boolean(),
  merchantId: enc,
  paymentKey: enc,
  payoutKey: enc,
  displayName: z.string().trim().min(2).max(60),
  description: z.string().max(200),
  minAmount: money4,
  maxAmount: money4,
  feeFixed: money4,
  feePercent: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/),
  sortOrder: z.number().int().min(0).max(100),
  /** Public webhook URL override (null = derived from APP_URL). */
  webhookUrl: z.url().max(255).nullable(),
  /** Also require webhooks to come from Cryptomus' published IP (behind a proxy, needs TRUST_PROXY). */
  verifyIp: z.boolean(),
  /** How long an invoice can be paid (Cryptomus allows 5 min – 12 h). */
  lifetimeMinutes: z.number().int().min(5).max(720),
});

export type MaintenanceSetting = z.infer<typeof MaintenanceSchema>;
export type ManualPaymentSetting = z.infer<typeof ManualPaymentSchema>;
export type PricingSetting = z.infer<typeof PricingSchema>;
export type CurrencyMarkupSetting = z.infer<typeof CurrencyMarkupSchema>;
export type CryptomusSetting = z.infer<typeof CryptomusSchema>;
/** Defaults; the add-funds page shows translated wording while these are unchanged. */
export const CRYPTOMUS_DEFAULT_NAME = "Crypto (Cryptomus)";
export const CRYPTOMUS_DEFAULT_DESCRIPTION =
  "Pay with USDT, BTC, ETH, TRX and other cryptocurrencies. Your balance is credited automatically once the payment is confirmed.";

const SCHEMAS = {
  maintenance: MaintenanceSchema,
  manual_payment: ManualPaymentSchema,
  pricing: PricingSchema,
  currency_markup: CurrencyMarkupSchema,
  chatbot_subscription: ChatbotSubscriptionSchema,
  payment_cryptomus: CryptomusSchema,
} as const;
type Key = keyof typeof SCHEMAS;
type Value<K extends Key> = z.infer<(typeof SCHEMAS)[K]>;

const DEFAULTS: { [K in Key]: () => Value<K> } = {
  maintenance: () => ({ enabled: false, message: "" }),
  // The business's receiving account (public payment details, not secrets). Admins can change them.
  manual_payment: () => ({ accountName: "Muhammad Usman", accountNumber: "03246623395", whatsapp: siteConfig.supportWhatsApp, note: "" }),
  currency_markup: () => ({ PKR: "0", INR: "0", BDT: "0" }),
  chatbot_subscription: () => ({ activatedAt: null, expiresAt: null }),
  payment_cryptomus: () => ({
    enabled: false,
    merchantId: null,
    paymentKey: null,
    payoutKey: null,
    displayName: CRYPTOMUS_DEFAULT_NAME,
    description: CRYPTOMUS_DEFAULT_DESCRIPTION,
    minAmount: "1",
    maxAmount: "1000",
    feeFixed: "0",
    feePercent: "0",
    sortOrder: 10,
    webhookUrl: null,
    verifyIp: false,
    lifetimeMinutes: 60,
  }),
  pricing: () => ({ markupPercent: String(env().PRICE_MARKUP_PERCENT), minMargin: String(env().PRICE_MIN_MARGIN) }),
};

const TTL_MS = 15_000;
const cache = new Map<Key, { value: unknown; at: number }>();

export async function getSetting<K extends Key>(key: K): Promise<Value<K>> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Value<K>;
  const row = await db().setting.findUnique({ where: { key } });
  const parsed = row ? SCHEMAS[key].safeParse(row.value) : null;
  const value = (parsed?.success ? parsed.data : DEFAULTS[key]()) as Value<K>;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function saveSetting<K extends Key>(key: K, value: Value<K>): Promise<Value<K>> {
  const clean = SCHEMAS[key].parse(value) as Value<K>;
  await db().setting.upsert({
    where: { key },
    create: { key, value: clean as Prisma.InputJsonValue },
    update: { value: clean as Prisma.InputJsonValue },
  });
  cache.set(key, { value: clean, at: Date.now() });
  return clean;
}

/** Tests only. */
export function clearSettingsCache() {
  cache.clear();
}

/**
 * WhatsApp number in international digits for a wa.me link. Pakistani local
 * mobile numbers are converted: "0302 4966223" / "+92 302 4966223" → "923024966223".
 */
export function whatsappDigits(value: string | null): string | null {
  let digits = value?.replace(/\D/g, "") ?? "";
  if (/^03\d{9}$/.test(digits)) digits = `92${digits.slice(1)}`;
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
