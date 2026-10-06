import "server-only";
import { z } from "zod";

/**
 * Server-side environment. Never import this from a client component —
 * `server-only` makes that a build error. Nothing here is exposed to the
 * browser (no NEXT_PUBLIC_ variables are used).
 */
const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((v) => v === "true");

/** "10" / "0.50": a non-negative amount with at most 2 decimals (whole cents). */
const decimalAmount = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, "Amount like 10 or 0.50");

const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use an ISO 4217 code such as USD")
  .default("USD");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** MySQL / MariaDB, e.g. mysql://user:pass@127.0.0.1:3306/virtumsg */
  DATABASE_URL: z
    .string()
    .refine((v) => /^(mysql|mariadb):\/\//.test(v), "Must be a mysql:// or mariadb:// URL")
    .optional(),

  /** Public origin used in emails and redirects, e.g. https://virtumsg.example. */
  APP_URL: z.url().default("http://localhost:3000"),

  /** Where uploaded blog images are stored (served at /media/blog/<file>). Keep it outside the build output. */
  BLOG_UPLOAD_DIR: z.string().min(1).default(".data/uploads/blog"),

  /** Set to true only when running behind a proxy that sets X-Forwarded-For. */
  TRUST_PROXY: bool("false"),

  /* Email (SMTP). Without SMTP_HOST, development/test write emails to an outbox. */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool("false"),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default("VirtuMSG <no-reply@example.com>"),
  /** Write emails to .data/outbox instead of sending (local testing of production builds). */
  MAIL_OUTBOX: bool("false"),

  /* Money */
  /** Currency customers are charged in and wallets hold. */
  PLATFORM_CURRENCY: currency,
  /** Currency the provider bills us in. */
  PROVIDER_CURRENCY: currency,
  /** Units of platform currency per 1 unit of provider currency. */
  PROVIDER_FX_RATE: z.coerce.number().positive().default(1),
  /** Customer price = provider cost × FX × (1 + markup%), at least cost + min margin. */
  PRICE_MARKUP_PERCENT: z.coerce.number().min(0).max(1000).default(20),
  PRICE_MIN_MARGIN: z.coerce.number().min(0).default(0.01),

  /* Upstream number provider */
  SMS_PROVIDER: z.enum(["grizzly", "none"]).default("none"),
  GRIZZLY_API_URL: z.url().default("https://api.grizzlysms.com/stubs/handler_api.php"),
  GRIZZLY_API_KEY: z.string().min(8).optional(),
  /** Upper bound on requests/second we send to the provider (per app instance). */
  PROVIDER_MAX_RPS: z.coerce.number().min(0.5).max(50).default(8),
  /** How often the full catalog (countries, services, prices) is refreshed. */
  CATALOG_SYNC_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  /* Wallet top-ups */
  /**
   * Top-up method. "manual" (default): Easypaisa / JazzCash payments the
   * customer sends and an administrator approves. "none" disables top-ups.
   * Future gateway APIs (Easypaisa, JazzCash) will add their own values and
   * credentials here.
   */
  PAYMENT_PROVIDER: z.enum(["manual", "none"]).default("manual"),
  /** Where new manual top-up requests are announced (optional; they always appear in /admin/topups). */
  ADMIN_NOTIFY_EMAIL: z.email().optional(),
  /** Top-up limits in the platform currency (whole cents). */
  TOPUP_MIN_AMOUNT: decimalAmount.default("1"),
  TOPUP_MAX_AMOUNT: decimalAmount.default("1000"),
  /** Gateway (redirect) providers only — manual top-ups carry no fee. Percent (up to 2 decimals) plus a fixed part. */
  TOPUP_FEE_PERCENT: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, "Percent like 2.5").default("0"),
  TOPUP_FEE_FIXED: decimalAmount.default("0"),
  /** Gateway (redirect) providers only: how long a created payment stays payable. */
  PAYMENT_EXPIRY_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(60),

  /**
   * Cryptomus (crypto top-ups). Normally configured in Admin → Settings →
   * Payments (stored encrypted); these are only the initial-deployment
   * fallback and are ignored for any value set in the admin panel.
   */
  CRYPTOMUS_MERCHANT_ID: z.string().min(8).max(100).optional(),
  CRYPTOMUS_PAYMENT_API_KEY: z.string().min(8).max(500).optional(),
  CRYPTOMUS_PAYOUT_API_KEY: z.string().min(8).max(500).optional(),
  /** Public webhook URL to give Cryptomus (default: APP_URL + /api/payments/webhook/cryptomus). */
  CRYPTOMUS_WEBHOOK_URL: z.url().optional(),
  /** Cryptomus API origin (override only for testing). */
  CRYPTOMUS_API_URL: z.url().default("https://api.cryptomus.com"),
  /**
   * 32-byte key (base64 or 64 hex chars) that encrypts payment credentials
   * saved in the admin panel (AES-256-GCM). Required to save credentials
   * there; generate with: openssl rand -base64 32. Keep it secret and stable —
   * changing it makes saved credentials unreadable (re-enter them).
   */
  SETTINGS_ENCRYPTION_KEY: z.string().min(32).max(200).optional(),

  /* Display-only currency conversion (never used for charging) */
  /**
   * Fixed display rates: units per 1 PLATFORM_CURRENCY unit, for the website
   * currency selector. Any that is unset uses the live rate from
   * EXCHANGE_RATES_URL (cached). Display only — never used for charging.
   */
  DISPLAY_PKR_RATE: z.coerce.number().positive().max(1_000_000).optional(),
  DISPLAY_INR_RATE: z.coerce.number().positive().max(1_000_000).optional(),
  DISPLAY_BDT_RATE: z.coerce.number().positive().max(1_000_000).optional(),
  /** Public exchange-rate API (no key); the base currency code is appended. */
  EXCHANGE_RATES_URL: z.url().default("https://open.er-api.com/v6/latest/"),
});

/** Cross-field rules. */
function checkPayments(e: z.infer<typeof schema>): string[] {
  const issues: string[] = [];
  const min = Number(e.TOPUP_MIN_AMOUNT);
  const max = Number(e.TOPUP_MAX_AMOUNT);
  if (!(min > 0) || max < min) issues.push("  TOPUP_MIN_AMOUNT/TOPUP_MAX_AMOUNT: need 0 < min <= max");
  return issues;
}

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Report which variables are wrong without echoing their values.
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment variables:\n${issues}`);
  }
  const extra = checkPayments(parsed.data);
  if (extra.length) throw new Error(`Invalid server environment variables:\n${extra.join("\n")}`);
  cached = parsed.data;
  return cached;
}

/** For tests that change process.env between cases. */
export function resetEnvCache() {
  cached = undefined;
}

export const isProduction = () => env().NODE_ENV === "production";
