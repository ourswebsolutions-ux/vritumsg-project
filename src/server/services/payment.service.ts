import "server-only";
import { randomBytes } from "node:crypto";
import { formatMoney, MONEY_SCALE, parseAmount, toDecimalString, toMinor, topUpFeeFor } from "@/lib/money";
import { sendEmail } from "@/server/email/mailer";
import { audit, auditInTx } from "@/server/admin/audit";
import type { AdminActor } from "@/server/admin/guard";
import { topUpApprovedEmail, topUpRejectedEmail, topUpRequestAdminEmail } from "@/server/email/templates";
import { hitRateLimit, RATE_LIMITS } from "@/server/auth/rate-limit";
import { siteConfig } from "@/config/site";
import { db, isUniqueViolation, type Prisma } from "@/server/db";
import type { PaymentStatus as DbPaymentStatus } from "@/generated/prisma/client";
import { env } from "@/server/env";
import { CRYPTOMUS_ID, loadCryptomusConfig } from "@/server/payments/cryptomus/config";
import { findPaymentProvider, listPaymentProviders } from "@/server/payments/registry";
import { PaymentProviderError, type PaymentProvider, type ProviderPaymentState } from "@/server/payments/types";
import type { Page, PaymentListItem, PaymentStatus, TopUpOptions, TopUpProviderOption } from "@/types/account";
import { platformCurrency } from "./currency";
import { CRYPTOMUS_DEFAULT_DESCRIPTION, CRYPTOMUS_DEFAULT_NAME, getSetting, whatsappDigits } from "./settings.service";
import { applyInTx } from "./wallet.service";

/**
 * Wallet top-ups: create a payment at the provider, send the customer to its
 * checkout, and credit the wallet once the provider confirms payment.
 *
 * Money rules:
 *  - amounts, fees and currency are decided here, never by the client;
 *  - nothing the browser sends (return URLs, "success" pages) is proof of
 *    payment: every path — webhook, return page, "check now", reconciliation —
 *    re-reads the payment from the provider and goes through settle();
 *  - settle() locks the payment row and credits through the wallet ledger
 *    with the unique reference "payment:<id>:credit", so one payment can
 *    produce exactly one credit however often it is confirmed;
 *  - an answer that doesn't match what we asked for (amount, currency,
 *    provider id, reference) is never credited; it is flagged for review.
 */

const CENT = MONEY_SCALE / 100;
/** Minimum time between provider status checks for one payment (polling). */
const CHECK_INTERVAL_MS = 5_000;
const OPEN: DbPaymentStatus[] = ["PENDING", "PROCESSING"];
/** Closed without payment, but a late payment would still be accepted. */
const UNPAID_CLOSED: DbPaymentStatus[] = ["FAILED", "CANCELLED", "EXPIRED"];
/** Unfinished payments one user may have at a time. */
const MAX_OPEN_PER_USER = 5;
/** Local expiry waits this long past the provider's deadline before giving up. */
const EXPIRY_GRACE_MS = 10 * 60_000;
/** Unpaid closed payments are re-checked for late payments this long. */
const LATE_PAYMENT_WINDOW_MS = 48 * 3600_000;
const PRESETS = [5, 10, 25, 50, 100].map((u) => u * MONEY_SCALE);

export type TopUpResult =
  | { ok: true; payment: PaymentListItem; redirectUrl: string | null }
  | {
      ok: false;
      code: "INVALID" | "UNAVAILABLE" | "RATE_LIMITED" | "TOO_MANY_PENDING" | "PROVIDER_ERROR" | "NOT_FOUND";
      message: string;
    };

/* ---------------------------------------------------------------- config -- */

function limits() {
  const e = env();
  return {
    min: toMinor(e.TOPUP_MIN_AMOUNT),
    max: toMinor(e.TOPUP_MAX_AMOUNT),
    // "2.5" % → 250 basis points (exact: at most 2 decimals).
    feeBps: toMinor(e.TOPUP_FEE_PERCENT) / 100,
    feeFixed: toMinor(e.TOPUP_FEE_FIXED),
    feePercent: e.TOPUP_FEE_PERCENT,
    currency: platformCurrency().code,
  };
}

/** Fee for a top-up: percent part rounded up to a whole cent, plus the fixed part. */
export function topUpFee(amount: number): number {
  const { feeBps, feeFixed } = limits();
  return topUpFeeFor(amount, feeBps, feeFixed);
}

type Limits = ReturnType<typeof limits>;

/** Limits and fees of one provider: Cryptomus has its own (admin settings); others use the TOPUP_* environment. */
async function limitsFor(provider: PaymentProvider): Promise<Limits> {
  if (provider.id !== CRYPTOMUS_ID) return limits();
  const c = await loadCryptomusConfig();
  return {
    min: toMinor(c.minAmount),
    max: toMinor(c.maxAmount),
    feeBps: toMinor(c.feePercent) / 100,
    feeFixed: toMinor(c.feeFixed),
    feePercent: c.feePercent,
    currency: platformCurrency().code,
  };
}

async function providerOption(provider: PaymentProvider): Promise<TopUpProviderOption> {
  const l = await limitsFor(provider);
  const methods = provider.methods();
  // Admin-customised Cryptomus wording; null keeps the translated defaults.
  const custom = provider.id === CRYPTOMUS_ID ? await loadCryptomusConfig() : null;
  return {
    id: provider.id,
    flow: provider.flow,
    label: custom && custom.displayName !== CRYPTOMUS_DEFAULT_NAME ? custom.displayName : null,
    description: custom && custom.description && custom.description !== CRYPTOMUS_DEFAULT_DESCRIPTION ? custom.description : null,
    test: !provider.live,
    currency: l.currency,
    min: l.min,
    max: l.max,
    feePercent: provider.flow === "manual" ? "0" : l.feePercent,
    feeFixed: provider.flow === "manual" ? 0 : l.feeFixed,
    presets: PRESETS.filter((p) => p >= l.min && p <= l.max),
    methods: methods.map(({ id, label, description, kind }) => ({ id, label, description, kind })),
  };
}

export async function getTopUpOptions(): Promise<TopUpOptions> {
  const providers = await Promise.all((await listPaymentProviders()).map(providerOption));
  const hasManual = providers.some((p) => p.flow === "manual");
  const details = hasManual ? await getSetting("manual_payment") : null;
  const first = providers[0];
  const l = limits();
  return {
    available: providers.some((p) => p.methods.length > 0),
    providers,
    // The fields below describe the first provider (kept for API clients written before several providers existed).
    flow: first?.flow ?? "redirect",
    manual: details
      ? { accountName: details.accountName, accountNumber: details.accountNumber, whatsapp: details.whatsapp, whatsappDigits: whatsappDigits(details.whatsapp), note: details.note }
      : null,
    test: first?.test ?? false,
    currency: first?.currency ?? l.currency,
    min: first?.min ?? l.min,
    max: first?.max ?? l.max,
    feePercent: first?.feePercent ?? l.feePercent,
    feeFixed: first?.feeFixed ?? l.feeFixed,
    presets: first?.presets ?? [],
    methods: providers.flatMap((p) => p.methods),
  };
}

/* ------------------------------------------------------------------ DTOs -- */

type PaymentRow = Prisma.PaymentGetPayload<object>;

const METHOD_LABELS: Record<string, string> = { easypaisa: "Easypaisa", jazzcash: "JazzCash" };

function methodLabel(row: PaymentRow): string {
  if (row.provider === CRYPTOMUS_ID) return "Crypto · Cryptomus";
  return METHOD_LABELS[row.method] ?? row.method.replace(/_/g, " ");
}

export function toPaymentItem(row: PaymentRow): PaymentListItem {
  const payable = row.status === "PENDING" && row.checkoutUrl !== null && (!row.expiresAt || row.expiresAt.getTime() > Date.now());
  return {
    id: row.id,
    reference: row.reference,
    amount: toMinor(row.amount),
    fee: toMinor(row.fee),
    total: toMinor(row.total),
    currency: row.currency,
    method: row.method,
    methodLabel: methodLabel(row),
    provider: row.provider,
    status: row.status.toLowerCase() as PaymentStatus,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    checkoutUrl: payable ? row.checkoutUrl : null,
    test: false,
    manual: row.provider === "manual",
    transactionId: row.provider === "manual" ? row.providerPaymentId : null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    rejectionReason: row.rejectionReason,
  };
}

function log(event: string, data: Record<string, unknown>, level: "warn" | "error" = "warn") {
  // Ids and codes only — never provider payloads, secrets or card data.
  console[level](JSON.stringify({ level, source: "payments", event, ...data }));
}

/* -------------------------------------------------------------- creation -- */

function newReference(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return `TP-${Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join("")}`;
}

export async function createTopUp(
  userId: string,
  input: { amount: string; method: string; idempotencyKey: string; provider?: string },
): Promise<TopUpResult> {
  // A resubmitted form returns the payment it already created.
  const existing = await db().payment.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return replay(existing);

  const maintenance = await getSetting("maintenance");
  if (maintenance.enabled) {
    return { ok: false, code: "UNAVAILABLE", message: maintenance.message || "We're doing maintenance. Top-ups are paused for a short while." };
  }

  const providers = await listPaymentProviders();
  if (!providers.length) return { ok: false, code: "UNAVAILABLE", message: "Adding funds isn't available yet. Please check back soon." };
  // Only enabled providers can start new payments (a disabled Cryptomus still settles old ones elsewhere).
  const provider = providers.find((p) => p.flow === "redirect" && (!input.provider || p.id === input.provider) && p.methods().some((m) => m.id === input.method));
  if (!provider) {
    if (providers.every((p) => p.flow === "manual")) return { ok: false, code: "INVALID", message: "Submit a manual top-up request instead." };
    return { ok: false, code: "INVALID", message: "Choose a payment method." };
  }

  const l = await limitsFor(provider);
  const amount = parseAmount(input.amount.trim().replace(",", "."));
  if (amount === null || amount % CENT !== 0) {
    return { ok: false, code: "INVALID", message: "Enter an amount like 10 or 12.50." };
  }
  if (amount < l.min || amount > l.max) {
    const f = (v: number) => toDecimalString(v).replace(/\.?0+$/, "");
    return { ok: false, code: "INVALID", message: `Enter an amount between ${f(l.min)} and ${f(l.max)} ${l.currency}.` };
  }

  const limit = await hitRateLimit(`payment:create:${userId}`, RATE_LIMITS.paymentCreatePerUser);
  if (!limit.allowed) return { ok: false, code: "RATE_LIMITED", message: "Too many payment attempts. Please wait a few minutes." };

  const open = await db().payment.count({ where: { userId, status: { in: OPEN }, expiresAt: { gt: new Date() } } });
  if (open >= MAX_OPEN_PER_USER) {
    return { ok: false, code: "TOO_MANY_PENDING", message: "You have several unfinished payments. Complete or wait for them before starting another." };
  }

  const fee = topUpFeeFor(amount, l.feeBps, l.feeFixed);
  const total = amount + fee;
  const lifetimeMinutes = provider.id === CRYPTOMUS_ID ? (await loadCryptomusConfig()).lifetimeMinutes : env().PAYMENT_EXPIRY_MINUTES;
  const expiresAt = new Date(Date.now() + lifetimeMinutes * 60_000);

  let payment: PaymentRow;
  try {
    payment = await db().payment.create({
      data: {
        reference: newReference(),
        userId,
        provider: provider.id,
        method: input.method,
        amount: toDecimalString(amount),
        fee: toDecimalString(fee),
        total: toDecimalString(total),
        currency: l.currency,
        idempotencyKey: input.idempotencyKey,
        expiresAt,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await db().payment.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
      if (winner) return replay(winner);
    }
    throw error;
  }

  const base = env().APP_URL.replace(/\/$/, "");
  try {
    const created = await provider.createPayment({
      reference: payment.reference,
      amount: total,
      currency: l.currency,
      method: input.method,
      description: `${siteConfig.name} balance top-up ${payment.reference}`,
      returnUrl: `${base}/profile/top-up/${payment.id}`,
      webhookUrl: `${base}/api/payments/webhook/${provider.id}`,
      expiresAt,
    });
    payment = await db().payment.update({
      where: { id: payment.id },
      data: { providerPaymentId: created.providerPaymentId, checkoutUrl: created.checkoutUrl, expiresAt: created.expiresAt ?? expiresAt },
    });
  } catch (error) {
    const code = error instanceof PaymentProviderError ? error.code : "INTERNAL";
    // Safe diagnostic for staff (provider message / field names — never credentials).
    const detail = (error instanceof PaymentProviderError ? error.message : "internal error").slice(0, 200);
    if (error instanceof PaymentProviderError && error.ambiguous) {
      // The provider may have created it; reconciliation looks it up by reference.
      await db().payment.update({ where: { id: payment.id }, data: { failureReason: "CREATE_UNCONFIRMED", metadata: { createError: detail } } });
    } else {
      await db().payment.update({ where: { id: payment.id }, data: { status: "FAILED", failedAt: new Date(), failureReason: code, metadata: { createError: detail } } });
    }
    log("create_failed", { paymentId: payment.id, provider: provider.id, code, detail });
    return { ok: false, code: "PROVIDER_ERROR", message: "We couldn't start the payment. You have not been charged — please try again." };
  }

  return { ok: true, payment: toPaymentItem(payment), redirectUrl: payment.checkoutUrl };
}

/** Outcome of a repeated submit: the same payment, never a second one. */
function replay(row: PaymentRow): TopUpResult {
  if (row.status === "FAILED" && !row.paidAt) {
    return { ok: false, code: "PROVIDER_ERROR", message: "We couldn't start the payment. You have not been charged — please try again." };
  }
  const item = toPaymentItem(row);
  return { ok: true, payment: item, redirectUrl: item.checkoutUrl };
}

/* ------------------------------------------------------------ settlement -- */

async function flagForReview(tx: Prisma.TransactionClient, paymentId: string, reason: string) {
  await tx.payment.update({ where: { id: paymentId }, data: { needsReview: true, failureReason: reason } });
  log("needs_review", { paymentId, reason }, "error");
}

/**
 * Applies the provider's authoritative state to our payment. Idempotent and
 * safe under concurrency (row lock); the only place a top-up credits a wallet.
 */
export async function settle(paymentId: string, state: ProviderPaymentState): Promise<void> {
  await db().$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    if (!locked.length) return;
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const now = new Date();

    // The answer must be about this payment.
    if ((p.providerPaymentId && state.providerPaymentId !== p.providerPaymentId) || (state.reference && state.reference !== p.reference)) {
      await flagForReview(tx, p.id, "PROVIDER_ID_MISMATCH");
      return;
    }

    // Keep the provider's latest non-secret details (status, network, tx hash, paid amount…) for staff.
    if (state.details) {
      const meta = (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata) ? p.metadata : {}) as Record<string, unknown>;
      await tx.payment.update({ where: { id: p.id }, data: { metadata: { ...meta, provider: { ...state.details, checkedAt: now.toISOString() } } as Prisma.InputJsonValue } });
    }

    switch (state.status) {
      case "paid": {
        if (p.status === "PAID" || p.status === "REFUNDED") return; // already processed
        if (state.amount !== toMinor(p.total) || state.currency !== p.currency) {
          await flagForReview(tx, p.id, "AMOUNT_MISMATCH");
          return;
        }
        await applyInTx(
          tx,
          {
            userId: p.userId,
            amount: toMinor(p.amount),
            type: "DEPOSIT",
            reference: `payment:${p.id}:credit`,
            description: p.provider === CRYPTOMUS_ID ? `Top-up · Cryptomus · ${p.reference}` : `Top-up · ${p.reference}`,
            paymentId: p.id,
            metadata: {
              provider: p.provider,
              providerPaymentId: state.providerPaymentId,
              orderId: p.reference,
              fee: toDecimalString(toMinor(p.fee)),
              ...(state.details?.txid ? { txid: String(state.details.txid) } : {}),
              ...(state.details?.network ? { network: String(state.details.network) } : {}),
            },
          },
          1,
        );
        await tx.payment.update({
          where: { id: p.id },
          data: {
            status: "PAID",
            paidAt: now,
            providerPaymentId: state.providerPaymentId,
            // Paid more than the invoice: the invoice amount is credited; staff decide about the difference.
            ...(state.overpaid ? { needsReview: true, failureReason: "OVERPAID" } : { failureReason: null }),
          },
        });
        if (state.overpaid) log("overpaid", { paymentId: p.id });
        return;
      }
      case "underpaid":
        // Final: the customer paid less than required. Never credited automatically.
        if (OPEN.includes(p.status) || UNPAID_CLOSED.includes(p.status)) {
          await tx.payment.update({ where: { id: p.id }, data: { status: "UNDERPAID", failedAt: now, needsReview: true, failureReason: "UNDERPAID" } });
          log("underpaid", { paymentId: p.id }, "error");
        }
        return;
      case "processing":
        if (p.status === "PENDING") await tx.payment.update({ where: { id: p.id }, data: { status: "PROCESSING" } });
        return;
      case "failed":
      case "cancelled":
      case "expired":
        if (OPEN.includes(p.status)) {
          const status = ({ failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED" } as const)[state.status];
          await tx.payment.update({ where: { id: p.id }, data: { status, failedAt: now } });
        }
        return;
      case "refunded":
        if (p.status === "PAID") {
          // Money went back to the customer after we credited it: staff must
          // correct the wallet with an adjustment (never an automatic debit).
          await tx.payment.update({ where: { id: p.id }, data: { status: "REFUNDED", needsReview: true, failureReason: "REFUNDED_AT_PROVIDER" } });
          log("refunded_at_provider", { paymentId: p.id }, "error");
        }
        return;
      case "pending":
        return;
    }
  });
}

/**
 * Re-reads one payment from the provider and settles it. Returns false when
 * the provider couldn't be reached (callers such as webhooks then retry).
 */
async function syncWithProvider(paymentId: string, opts: { force?: boolean; notified?: boolean } = {}): Promise<boolean> {
  const p = await db().payment.findUnique({ where: { id: paymentId } });
  // Paid payments are final for polling; a provider notification may still
  // report a later refund, which is flagged for staff.
  if (!p || p.status === "REFUNDED" || p.status === "REJECTED" || (p.status === "PAID" && !opts.notified)) return true;
  // Manual top-ups have no remote status: an administrator's review decides.
  if (p.provider === "manual") return true;
  // Also when the provider was disabled since: payments created earlier must still settle.
  const provider = await findPaymentProvider(p.provider);
  if (!provider) return true;
  const now = Date.now();
  if (!opts.force && p.lastCheckedAt && now - p.lastCheckedAt.getTime() < CHECK_INTERVAL_MS) return true;
  await db().payment.update({ where: { id: p.id }, data: { lastCheckedAt: new Date(now) } });

  const pastDeadline = p.expiresAt !== null && p.expiresAt.getTime() + EXPIRY_GRACE_MS < now;
  let state: ProviderPaymentState | null;
  try {
    state = p.providerPaymentId
      ? await provider.getPayment(p.providerPaymentId)
      : ((await provider.findPaymentByReference?.(p.reference)) ?? null);
  } catch (error) {
    if (error instanceof PaymentProviderError && error.code === "NOT_FOUND") {
      state = null;
    } else {
      log("status_check_failed", { paymentId: p.id, code: error instanceof PaymentProviderError ? error.code : "INTERNAL" });
      return false;
    }
  }

  if (state) {
    if (!p.providerPaymentId) {
      await db().payment.updateMany({ where: { id: p.id, providerPaymentId: null }, data: { providerPaymentId: state.providerPaymentId } });
    }
    await settle(p.id, state);
  }
  // Still open long after its deadline (or unknown to the provider): close it.
  // A payment that arrives later is still credited (settle accepts late "paid").
  if ((!state || state.status === "pending") && pastDeadline) {
    await db().payment.updateMany({ where: { id: p.id, status: { in: OPEN } }, data: { status: "EXPIRED", failedAt: new Date() } });
  }
  return true;
}

/* ------------------------------------------------------------- user reads -- */

/** One of the user's payments; open payments are re-checked with the provider (throttled). */
export async function getTopUp(userId: string, paymentId: string): Promise<PaymentListItem | null> {
  const p = await db().payment.findFirst({ where: { id: paymentId, userId }, select: { id: true, status: true } });
  if (!p) return null;
  if (OPEN.includes(p.status)) await syncWithProvider(p.id).catch(() => {});
  const row = await db().payment.findUniqueOrThrow({ where: { id: p.id } });
  return toPaymentItem(row);
}

/** "Check now": an immediate provider check (rate limited per user). */
export async function verifyTopUp(userId: string, paymentId: string): Promise<TopUpResult> {
  const p = await db().payment.findFirst({ where: { id: paymentId, userId }, select: { id: true, status: true } });
  if (!p) return { ok: false, code: "NOT_FOUND", message: "Payment not found." };
  if (OPEN.includes(p.status) || UNPAID_CLOSED.includes(p.status)) {
    const limit = await hitRateLimit(`payment:verify:${userId}`, RATE_LIMITS.paymentVerifyPerUser);
    if (!limit.allowed) return { ok: false, code: "RATE_LIMITED", message: "Please wait a moment before checking again." };
    await syncWithProvider(p.id, { force: true });
  }
  const row = await db().payment.findUniqueOrThrow({ where: { id: p.id } });
  const item = toPaymentItem(row);
  return { ok: true, payment: item, redirectUrl: item.checkoutUrl };
}

const FILTER: Record<"all" | "pending" | "paid" | "unpaid", DbPaymentStatus[] | null> = {
  all: null,
  pending: OPEN,
  paid: ["PAID"],
  unpaid: ["FAILED", "CANCELLED", "EXPIRED", "REFUNDED", "REJECTED", "UNDERPAID"],
};

export async function listTopUps(
  userId: string,
  filter: { status?: keyof typeof FILTER; from?: Date; to?: Date; page?: number; pageSize?: number } = {},
): Promise<Page<PaymentListItem>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 20));
  const statuses = FILTER[filter.status ?? "all"];
  const where: Prisma.PaymentWhereInput = {
    userId,
    ...(statuses ? { status: { in: statuses } } : {}),
    ...(filter.from || filter.to ? { createdAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    db().payment.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db().payment.count({ where }),
  ]);
  return { items: rows.map(toPaymentItem), total, page, pageSize };
}

/** Unfinished payments the customer can still complete or check. */
export async function listOpenTopUps(userId: string): Promise<PaymentListItem[]> {
  const rows = await db().payment.findMany({ where: { userId, status: { in: OPEN } }, orderBy: { createdAt: "desc" }, take: MAX_OPEN_PER_USER });
  return rows.map(toPaymentItem);
}

/* --------------------------------------------------------------- webhooks -- */

export type WebhookOutcome = { status: number; body: { received: boolean; duplicate?: boolean; error?: string } };

/**
 * Handles a provider notification. Its authenticity is verified by the
 * provider adapter; its content is only a hint about *which* payment changed —
 * the state itself is fetched from the provider before anything is credited.
 */
export async function handlePaymentWebhook(providerId: string, rawBody: string, headers: Headers): Promise<WebhookOutcome> {
  // A provider an admin has disabled still receives notifications for its existing payments.
  const provider = await findPaymentProvider(providerId);
  if (!provider) return { status: 404, body: { received: false, error: "unknown_provider" } };

  let event;
  try {
    event = provider.verifyWebhook(rawBody, headers);
  } catch (error) {
    const code = error instanceof PaymentProviderError ? error.code : "INVALID_PAYLOAD";
    log("webhook_rejected", { provider: provider.id, code });
    // Unverified content is never stored — only the fact and the reason.
    await db()
      .systemLog.create({ data: { level: "WARN", source: "payments", message: "webhook_rejected", context: { provider: provider.id, reason: code } } })
      .catch(() => {});
    return code === "INVALID_SIGNATURE"
      ? { status: 401, body: { received: false, error: "invalid_signature" } }
      : { status: 400, body: { received: false, error: "invalid_payload" } };
  }

  const match: Prisma.PaymentWhereInput[] = [];
  if (event.providerPaymentId) match.push({ providerPaymentId: event.providerPaymentId });
  if (event.reference) match.push({ reference: event.reference });
  const payment = match.length ? await db().payment.findFirst({ where: { provider: provider.id, OR: match }, select: { id: true } }) : null;

  // Deduplicate deliveries; an event that wasn't fully handled is processed again.
  let record: { id: string; processedAt: Date | null };
  try {
    record = await db().paymentEvent.create({
      data: { provider: provider.id, eventId: event.eventId, type: event.type.slice(0, 64), paymentId: payment?.id ?? null },
      select: { id: true, processedAt: true },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    record = await db().paymentEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: provider.id, eventId: event.eventId } },
      select: { id: true, processedAt: true },
    });
    if (record.processedAt) return { status: 200, body: { received: true, duplicate: true } };
  }

  if (!payment) {
    log("webhook_unknown_payment", { provider: provider.id, eventId: event.eventId });
    await db().paymentEvent.update({ where: { id: record.id }, data: { processedAt: new Date(), result: "unknown_payment", error: "No payment with this order ID / invoice." } });
    return { status: 200, body: { received: true } };
  }
  let synced: boolean;
  try {
    synced = await syncWithProvider(payment.id, { force: true, notified: true });
  } catch (error) {
    await db().paymentEvent.update({ where: { id: record.id }, data: { result: "error", error: (error instanceof Error ? error.message : "error").slice(0, 255) } });
    throw error;
  }
  if (!synced) {
    await db().paymentEvent.update({ where: { id: record.id }, data: { result: "retry", error: "Provider unreachable while confirming the payment." } });
    return { status: 503, body: { received: false, error: "retry_later" } }; // provider will redeliver
  }
  const after = await db().payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, needsReview: true, failureReason: true } });
  await db().paymentEvent.update({
    where: { id: record.id },
    data: {
      processedAt: new Date(),
      result: `payment_${after.status.toLowerCase()}`.slice(0, 32),
      error: after.needsReview ? (after.failureReason ?? "needs review").slice(0, 255) : null,
    },
  });
  return { status: 200, body: { received: true } };
}

/* --------------------------------------------------------- reconciliation -- */

/**
 * Brings local payments in line with the provider: open payments (webhook
 * late or lost, browser closed), and recently closed unpaid ones in case the
 * customer paid late. Run periodically: npm run payments:reconcile.
 */
export async function reconcilePayments(limit = 200): Promise<{ checked: number; paid: number; closed: number; unreachable: number; needsReview: number }> {
  const since = new Date(Date.now() - LATE_PAYMENT_WINDOW_MS);
  const due = await db().payment.findMany({
    where: {
      provider: { not: "manual" }, // reviewed by administrators, not polled
      OR: [{ status: { in: OPEN } }, { status: { in: UNPAID_CLOSED }, createdAt: { gte: since }, providerPaymentId: { not: null } }],
    },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
    select: { id: true, status: true },
    take: limit,
  });
  let unreachable = 0;
  for (const p of due) {
    if (!(await syncWithProvider(p.id, { force: true }).catch(() => false))) unreachable++;
  }
  const after = await db().payment.findMany({ where: { id: { in: due.map((p) => p.id) } }, select: { id: true, status: true } });
  const before = new Map(due.map((p) => [p.id, p.status]));
  const changed = after.filter((p) => before.get(p.id) !== p.status);
  return {
    checked: due.length,
    paid: changed.filter((p) => p.status === "PAID").length,
    closed: changed.filter((p) => UNPAID_CLOSED.includes(p.status)).length,
    unreachable,
    needsReview: await db().payment.count({ where: { needsReview: true } }),
  };
}

/**
 * Staff tool: re-read one payment from the provider now and settle it
 * (credits only through settle(); also detects refunds of paid payments).
 */
export async function recheckPayment(paymentId: string): Promise<boolean> {
  return syncWithProvider(paymentId, { force: true, notified: true });
}

/* ------------------------------------------------------ manual top-ups -- */

const MANUAL = "manual";

/** Easypaisa / JazzCash transaction IDs: letters and digits, normalized to upper case. */
export function normalizeTransactionId(value: string): string | null {
  const v = value.trim().toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9-]{6,40}$/.test(v) ? v : null;
}

/**
 * A customer's manual top-up request: they have sent money to the account on
 * the Add funds page and give its transaction ID. Nothing is credited here —
 * the request waits (PENDING) for an administrator to verify and approve it.
 * The same transaction ID can never be submitted twice.
 */
export async function createManualTopUp(
  userId: string,
  input: { amount: string; method: string; transactionId: string; note?: string; idempotencyKey: string },
): Promise<TopUpResult> {
  const existing = await db().payment.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return { ok: true, payment: toPaymentItem(existing), redirectUrl: null };

  const maintenance = await getSetting("maintenance");
  if (maintenance.enabled) {
    return { ok: false, code: "UNAVAILABLE", message: maintenance.message || "We're doing maintenance. Top-ups are paused for a short while." };
  }
  const provider = (await listPaymentProviders()).find((p) => p.flow === "manual");
  if (!provider) return { ok: false, code: "UNAVAILABLE", message: "Manual top-ups aren't available right now." };
  if (!provider.methods().some((m) => m.id === input.method)) return { ok: false, code: "INVALID", message: "Choose Easypaisa or JazzCash." };

  const l = limits();
  const amount = parseAmount(input.amount.trim().replace(",", "."));
  if (amount === null || amount % CENT !== 0) return { ok: false, code: "INVALID", message: "Enter an amount like 10 or 12.50." };
  if (amount < l.min || amount > l.max) {
    const f = (v: number) => toDecimalString(v).replace(/\.?0+$/, "");
    return { ok: false, code: "INVALID", message: `Enter an amount between ${f(l.min)} and ${f(l.max)} ${l.currency}.` };
  }
  const transactionId = normalizeTransactionId(input.transactionId);
  if (!transactionId) return { ok: false, code: "INVALID", message: "Enter the transaction ID from your Easypaisa / JazzCash receipt (6–40 letters or digits)." };
  const note = (input.note ?? "").trim().slice(0, 300);

  const limit = await hitRateLimit(`payment:create:${userId}`, RATE_LIMITS.paymentCreatePerUser);
  if (!limit.allowed) return { ok: false, code: "RATE_LIMITED", message: "Too many requests. Please wait a few minutes." };

  const pending = await db().payment.count({ where: { userId, provider: MANUAL, status: "PENDING" } });
  if (pending >= MAX_OPEN_PER_USER) {
    return { ok: false, code: "TOO_MANY_PENDING", message: "You already have several requests waiting for verification. Please wait for them to be reviewed." };
  }
  const taken = await db().payment.findUnique({ where: { provider_providerPaymentId: { provider: MANUAL, providerPaymentId: transactionId } } });
  if (taken) {
    // The same submission arriving twice (double click, retry) returns the first one.
    if (taken.userId === userId && taken.idempotencyKey === input.idempotencyKey) return { ok: true, payment: toPaymentItem(taken), redirectUrl: null };
    return { ok: false, code: "INVALID", message: "This transaction ID has already been submitted." };
  }

  let payment: PaymentRow;
  try {
    payment = await db().payment.create({
      data: {
        reference: newReference(),
        userId,
        provider: MANUAL,
        method: input.method,
        amount: toDecimalString(amount),
        fee: "0",
        total: toDecimalString(amount),
        currency: l.currency,
        providerPaymentId: transactionId,
        idempotencyKey: input.idempotencyKey,
        ...(note ? { metadata: { note } } : {}),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await db().payment.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } } });
      if (again) return { ok: true, payment: toPaymentItem(again), redirectUrl: null };
      return { ok: false, code: "INVALID", message: "This transaction ID has already been submitted." };
    }
    throw error;
  }
  await audit(
    null,
    "topup.created",
    { type: "payment", id: payment.id },
    true,
    { userId, reference: payment.reference, amount: toDecimalString(amount), method: input.method },
    `Top-up request ${payment.reference} (${formatMoney(amount, l.currency)}) submitted`,
  );
  void notifyAdminOfTopUp(payment);
  return { ok: true, payment: toPaymentItem(payment), redirectUrl: null };
}

async function send(message: Parameters<typeof sendEmail>[0], what: string) {
  try {
    await sendEmail(message);
  } catch (error) {
    log("email_failed", { what, code: error instanceof Error ? error.name : "unknown" });
  }
}

async function notifyAdminOfTopUp(p: PaymentRow) {
  const to = env().ADMIN_NOTIFY_EMAIL;
  if (!to) return;
  const user = await db().user.findUnique({ where: { id: p.userId }, select: { email: true } });
  await send(
    topUpRequestAdminEmail(to, {
      reference: p.reference,
      customer: user?.email ?? "a customer",
      amount: formatMoney(toMinor(p.amount), p.currency),
      method: p.method === "jazzcash" ? "JazzCash" : "Easypaisa",
      transactionId: p.providerPaymentId ?? "—",
      url: `${env().APP_URL.replace(/\/$/, "")}/admin/topups/${p.id}`,
    }),
    "topup_admin_notice",
  );
}

export type ReviewResult =
  | { ok: true; payment: PaymentListItem; userId: string; ledgerId?: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" | "SELF_REVIEW" | "INVALID"; message: string };

/**
 * Approves a manual top-up and credits the wallet — exactly once. Row lock +
 * PENDING check + the ledger's unique reference make double clicks, two
 * admin tabs and retried requests all end with one credit.
 */
export async function approveManualTopUp(reviewer: AdminActor | string, paymentId: string): Promise<ReviewResult> {
  const actor = typeof reviewer === "string" ? null : reviewer;
  const reviewerId = typeof reviewer === "string" ? reviewer : reviewer.id;
  const outcome = await db().$transaction(async (tx): Promise<ReviewResult> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    if (!locked.length) return { ok: false, code: "NOT_FOUND", message: "Top-up request not found." };
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.provider !== MANUAL) return { ok: false, code: "NOT_FOUND", message: "Top-up request not found." };
    if (p.status !== "PENDING") return { ok: false, code: "NOT_PENDING", message: `This request was already ${p.status === "PAID" ? "approved" : p.status.toLowerCase()}.` };
    if (p.userId === reviewerId) return { ok: false, code: "SELF_REVIEW", message: "You can't approve your own top-up. Ask another administrator." };
    const { entry } = await applyInTx(
      tx,
      {
        userId: p.userId,
        amount: toMinor(p.amount),
        type: "DEPOSIT",
        reference: `payment:${p.id}:credit`,
        description: `Top-up · ${p.method === "jazzcash" ? "JazzCash" : "Easypaisa"} · ${p.reference}`,
        paymentId: p.id,
        metadata: { approvedBy: reviewerId },
      },
      1,
    );
    const now = new Date();
    const row = await tx.payment.update({ where: { id: p.id }, data: { status: "PAID", paidAt: now, reviewedById: reviewerId, reviewedAt: now } });
    // Audit commits with the credit (or not at all).
    const amount = formatMoney(toMinor(p.amount), p.currency);
    const meta = { userId: p.userId, reference: p.reference, amount: toDecimalString(toMinor(p.amount)), currency: p.currency, method: p.method };
    await auditInTx(tx, actor, { action: "topup.approved", target: { type: "payment", id: p.id }, success: true, metadata: meta, description: `Approved top-up ${p.reference} (${amount})` });
    await auditInTx(tx, actor, {
      action: "wallet.credited",
      target: { type: "user", id: p.userId },
      success: true,
      metadata: { ...meta, paymentId: p.id, transactionId: entry.id },
      description: `Credited ${amount} for top-up ${p.reference}`,
    });
    return { ok: true, payment: toPaymentItem(row), userId: p.userId, ledgerId: entry.id };
  });
  if (outcome.ok) void notifyCustomer(outcome.userId, outcome.payment, "approved");
  return outcome;
}

/** Rejects a pending manual top-up (never credited). The customer sees the reason. */
export async function rejectManualTopUp(reviewer: AdminActor | string, paymentId: string, reason: string): Promise<ReviewResult> {
  const actor = typeof reviewer === "string" ? null : reviewer;
  const reviewerId = typeof reviewer === "string" ? reviewer : reviewer.id;
  const why = reason.trim();
  if (why.length < 5 || why.length > 300) return { ok: false, code: "INVALID", message: "Give the customer a reason (5–300 characters)." };
  const outcome = await db().$transaction(async (tx): Promise<ReviewResult> => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    if (!locked.length) return { ok: false, code: "NOT_FOUND", message: "Top-up request not found." };
    const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.provider !== MANUAL) return { ok: false, code: "NOT_FOUND", message: "Top-up request not found." };
    if (p.status !== "PENDING") return { ok: false, code: "NOT_PENDING", message: `This request was already ${p.status === "PAID" ? "approved" : p.status.toLowerCase()}.` };
    const now = new Date();
    const row = await tx.payment.update({
      where: { id: p.id },
      data: { status: "REJECTED", failedAt: now, reviewedById: reviewerId, reviewedAt: now, rejectionReason: why },
    });
    await auditInTx(tx, actor, {
      action: "topup.rejected",
      target: { type: "payment", id: p.id },
      success: true,
      metadata: { userId: p.userId, reference: p.reference, amount: toDecimalString(toMinor(p.amount)), reason: why },
      description: `Rejected top-up ${p.reference} (${formatMoney(toMinor(p.amount), p.currency)}): ${why}`,
    });
    return { ok: true, payment: toPaymentItem(row), userId: p.userId };
  });
  if (outcome.ok) void notifyCustomer(outcome.userId, outcome.payment, "rejected");
  return outcome;
}

async function notifyCustomer(userId: string, p: PaymentListItem, outcome: "approved" | "rejected") {
  const user = await db().user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  if (!user) return;
  const base = env().APP_URL.replace(/\/$/, "");
  await send(
    outcome === "approved"
      ? topUpApprovedEmail(user.email, user.name, formatMoney(p.amount, p.currency), p.reference, `${base}/price`)
      : topUpRejectedEmail(user.email, user.name, p.reference, p.rejectionReason ?? "", `${base}/profile/top-up/${p.id}`),
    `topup_${outcome}`,
  );
}
