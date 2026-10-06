import "server-only";
import { toMinor } from "@/lib/money";
import { db, type Prisma } from "@/server/db";
import { cancelOrder, getOrderDetail, refreshOrder } from "@/server/services/order.service";
import { CRYPTOMUS_ID } from "@/server/payments/cryptomus/config";
import { CryptomusPaymentProvider } from "@/server/payments/cryptomus/provider";
import { findPaymentProvider } from "@/server/payments/registry";
import { PaymentProviderError } from "@/server/payments/types";
import { recheckPayment } from "@/server/services/payment.service";
import type { OrderStatus, PaymentStatus, TransactionType } from "@/types/account";
import type { AdminLedgerRow, AdminOrderRow, AdminPage, AdminPaymentRow } from "@/types/admin";
import { audit } from "./audit";
import type { AdminActor } from "./guard";
import type { AdminResult } from "./users";
import { serviceLogo } from "@/lib/service-logos";

/** Admin views of orders and payments, plus their provider-backed actions. */

type DateRange = { from?: Date; to?: Date };
const createdIn = (r: DateRange) => (r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lte: r.to } : {}) } } : {});
const ORDER_STATUSES = ["PENDING", "ACTIVE", "SMS_RECEIVED", "COMPLETED", "CANCELLED", "REFUNDED", "FAILED", "EXPIRED"] as const;
const PAYMENT_STATUSES = ["PENDING", "PROCESSING", "PAID", "FAILED", "CANCELLED", "EXPIRED", "REFUNDED", "REJECTED", "UNDERPAID"] as const;

const ledgerRow = (t: { id: string; type: string; amount: Prisma.Decimal; balanceAfter: Prisma.Decimal; description: string | null; createdAt: Date }): AdminLedgerRow => ({
  id: t.id,
  type: t.type.toLowerCase() as TransactionType,
  amount: toMinor(t.amount),
  balanceAfter: toMinor(t.balanceAfter),
  description: t.description,
  createdAt: t.createdAt.toISOString(),
});

/* ---------------------------------------------------------------- orders -- */

const orderSelect = {
  id: true,
  userId: true,
  phoneNumber: true,
  status: true,
  price: true,
  currency: true,
  providerActivationId: true,
  provider: true,
  completedAt: true,
  createdAt: true,
  user: { select: { id: true, email: true } },
  service: { select: { name: true, slug: true, providerCode: true } },
  country: { select: { name: true, iso2: true } },
  _count: { select: { sms: true } },
} satisfies Prisma.OrderSelect;

const toOrderRow = (o: Prisma.OrderGetPayload<{ select: typeof orderSelect }>): AdminOrderRow => ({
  id: o.id,
  user: o.user,
  service: { name: o.service.name, slug: o.service.slug, logo: serviceLogo(o.service.providerCode) },
  country: o.country,
  phoneNumber: o.phoneNumber,
  status: o.status.toLowerCase() as OrderStatus,
  price: toMinor(o.price),
  currency: o.currency,
  providerActivationId: o.providerActivationId,
  smsCount: o._count.sms,
  provider: o.provider,
  completedAt: o.completedAt?.toISOString() ?? null,
  createdAt: o.createdAt.toISOString(),
});

export type OrderFilter = DateRange & {
  q?: string;
  status?: string;
  serviceId?: number;
  countryId?: number;
  userId?: string;
  provider?: string;
  page?: number;
  pageSize?: number;
};

export async function listAdminOrders(filter: OrderFilter = {}): Promise<AdminPage<AdminOrderRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
  const q = filter.q?.trim();
  const status = ORDER_STATUSES.find((s) => s === filter.status?.toUpperCase());
  const where: Prisma.OrderWhereInput = {
    ...(status ? { status } : {}),
    ...(filter.serviceId ? { serviceId: filter.serviceId } : {}),
    ...(filter.countryId ? { countryId: filter.countryId } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.provider ? { provider: filter.provider } : {}),
    ...createdIn(filter),
    ...(q
      ? {
          OR: [
            ...(/^#?[0-9a-f-]{4,36}$/i.test(q) ? [{ id: { startsWith: q.replace(/^#/, "").toLowerCase() } }] : []),
            { user: { email: { contains: q.toLowerCase() } } },
            ...(/\d{4,}/.test(q) ? [{ phoneNumber: { contains: q.replace(/\D/g, "") } }, { providerActivationId: q.trim() }] : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db().order.findMany({ where, select: orderSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db().order.count({ where }),
  ]);
  return { items: rows.map(toOrderRow), total, page, pageSize };
}

export async function getAdminOrder(orderId: string) {
  const row = await db().order.findUnique({ where: { id: orderId }, select: { ...orderSelect, failureReason: true, providerCost: true } });
  if (!row) return null;
  const [detail, requests] = await Promise.all([
    getOrderDetail(row.userId, orderId),
    // Provider calls for this order: action and outcome only (no raw params/responses).
    db().providerRequest.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, action: true, success: true, errorCategory: true, errorCode: true, httpStatus: true, durationMs: true, createdAt: true },
    }),
  ]);
  return {
    order: toOrderRow(row),
    detail: detail!,
    failureReason: row.failureReason,
    providerCost: row.providerCost ? toMinor(row.providerCost) : null,
    requests: requests.map((r) => ({ ...r, id: String(r.id), createdAt: r.createdAt.toISOString() })),
  };
}

export async function adminRefreshOrder(actor: AdminActor, orderId: string): Promise<AdminResult> {
  const order = await db().order.findUnique({ where: { id: orderId }, select: { status: true } });
  if (!order) return { ok: false, message: "Order not found." };
  try {
    await refreshOrder(orderId, { force: true });
    const after = await db().order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    await audit(actor, "order.refresh", { type: "order", id: orderId }, true, { from: order.status, to: after.status }, `Refreshed order ${orderId.slice(0, 8)}: ${order.status.toLowerCase()} → ${after.status.toLowerCase()}`);
    return { ok: true, message: after.status === order.status ? "Status is up to date." : `Status changed to ${after.status.toLowerCase()}.` };
  } catch (error) {
    await audit(actor, "order.refresh", { type: "order", id: orderId }, false, { error: error instanceof Error ? error.name : "unknown" }, `Provider unreachable while refreshing order ${orderId.slice(0, 8)}`);
    return { ok: false, message: "The provider couldn't be reached. Try again later." };
  }
}

/** Cancels at the provider on the customer's behalf; refunds follow the normal (idempotent) rules. */
export async function adminCancelOrder(actor: AdminActor, orderId: string): Promise<AdminResult> {
  const order = await db().order.findUnique({ where: { id: orderId }, select: { userId: true, status: true } });
  if (!order) return { ok: false, message: "Order not found." };
  const r = await cancelOrder(order.userId, orderId);
  await audit(
    actor,
    "order.cancel",
    { type: "order", id: orderId },
    r.ok,
    r.ok ? { from: order.status, to: r.order.status } : { error: r.code },
    r.ok ? `Cancelled order ${orderId.slice(0, 8)} at the provider (refunded)` : `Cancel refused for order ${orderId.slice(0, 8)}: ${r.message}`,
  );
  return r.ok ? { ok: true, message: "Order cancelled and refunded." } : { ok: false, message: r.message };
}

/* -------------------------------------------------------------- payments -- */

const paymentSelect = {
  id: true,
  reference: true,
  provider: true,
  method: true,
  status: true,
  amount: true,
  fee: true,
  total: true,
  currency: true,
  providerPaymentId: true,
  needsReview: true,
  failureReason: true,
  createdAt: true,
  paidAt: true,
  reviewedById: true,
  reviewedAt: true,
  rejectionReason: true,
  user: { select: { id: true, email: true } },
} satisfies Prisma.PaymentSelect;

const toPaymentRow = (p: Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>, reviewers: Map<string, string> = new Map()): AdminPaymentRow => ({
  id: p.id,
  reference: p.reference,
  user: p.user,
  provider: p.provider,
  method: p.method,
  status: p.status.toLowerCase() as PaymentStatus,
  amount: toMinor(p.amount),
  fee: toMinor(p.fee),
  total: toMinor(p.total),
  currency: p.currency,
  providerPaymentId: p.providerPaymentId,
  needsReview: p.needsReview,
  failureReason: p.failureReason,
  createdAt: p.createdAt.toISOString(),
  paidAt: p.paidAt?.toISOString() ?? null,
  reviewedBy: p.reviewedById ? (reviewers.get(p.reviewedById) ?? null) : null,
  reviewedAt: p.reviewedAt?.toISOString() ?? null,
  rejectionReason: p.rejectionReason,
});

async function reviewerEmails(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db().user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true } });
  return new Map(rows.map((r) => [r.id, r.email]));
}

export type PaymentFilter = DateRange & { q?: string; status?: string; review?: boolean; userId?: string; provider?: string; method?: string; page?: number; pageSize?: number };

export async function listAdminPayments(filter: PaymentFilter = {}): Promise<AdminPage<AdminPaymentRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
  const q = filter.q?.trim();
  const status = PAYMENT_STATUSES.find((s) => s === filter.status?.toUpperCase());
  const where: Prisma.PaymentWhereInput = {
    ...(status ? { status } : {}),
    ...(filter.review ? { needsReview: true } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...(filter.provider ? { provider: filter.provider } : {}),
    ...(filter.method ? { method: filter.method } : {}),
    ...createdIn(filter),
    ...(q
      ? {
          OR: [
            { reference: { startsWith: q.toUpperCase() } },
            { providerPaymentId: q.toUpperCase().replace(/\s+/g, "") },
            { providerPaymentId: q },
            { user: { email: { contains: q.toLowerCase() } } },
            ...(/^[0-9a-f-]{4,36}$/i.test(q) ? [{ id: { startsWith: q.toLowerCase() } }] : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db().payment.findMany({ where, select: paymentSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db().payment.count({ where }),
  ]);
  const reviewers = await reviewerEmails(rows.map((r) => r.reviewedById));
  return { items: rows.map((r) => toPaymentRow(r, reviewers)), total, page, pageSize };
}

export async function getAdminPayment(paymentId: string) {
  const row = await db().payment.findUnique({
    where: { id: paymentId },
    select: { ...paymentSelect, expiresAt: true, metadata: true, reviewedById: true, reviewedAt: true, rejectionReason: true },
  });
  if (!row) return null;
  const [ledger, events] = await Promise.all([
    db().transaction.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } }),
    db().paymentEvent.findMany({ where: { paymentId }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, eventId: true, type: true, processedAt: true, result: true, error: true, createdAt: true } }),
  ]);
  const meta = row.metadata as {
    review?: { by: string; at: string; note: string };
    note?: string;
    provider?: Record<string, unknown>;
    createError?: unknown;
  } | null;
  // Provider-reported details (network, TXID, coin amount, …) recorded on settlement: plain values only.
  const providerDetails = Object.entries(meta?.provider ?? {})
    .filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]))
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const review = meta?.review ?? null;
  const reviewer = row.reviewedById ? await db().user.findUnique({ where: { id: row.reviewedById }, select: { email: true } }) : null;
  return {
    payment: toPaymentRow(row, await reviewerEmails([row.reviewedById])),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    review,
    customerNote: meta?.note ?? null,
    providerDetails,
    createError: typeof meta?.createError === "string" ? meta.createError : null,
    manualReview: row.reviewedAt ? { by: reviewer?.email ?? "—", at: row.reviewedAt.toISOString(), rejectionReason: row.rejectionReason } : null,
    ledger: ledger.map(ledgerRow),
    events: events.map((e) => ({ ...e, processedAt: e.processedAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() })),
  };
}

export async function adminRecheckPayment(actor: AdminActor, paymentId: string): Promise<AdminResult> {
  const before = await db().payment.findUnique({ where: { id: paymentId }, select: { status: true } });
  if (!before) return { ok: false, message: "Payment not found." };
  const reached = await recheckPayment(paymentId);
  const after = await db().payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true, needsReview: true } });
  await audit(
    actor,
    "payment.recheck",
    { type: "payment", id: paymentId },
    reached,
    { from: before.status, to: after.status, needsReview: after.needsReview },
    reached ? `Re-checked payment with provider: ${before.status.toLowerCase()} → ${after.status.toLowerCase()}` : "Payment provider unreachable on re-check",
  );
  if (!reached) return { ok: false, message: "The payment provider couldn't be reached." };
  return { ok: true, message: after.status === before.status ? `Provider confirms: ${after.status.toLowerCase()}.` : `Status changed to ${after.status.toLowerCase()}.` };
}

/**
 * Asks Cryptomus to send the payment notification again (allowed for
 * paid / paid_over / wrong_amount invoices). The webhook that follows is
 * verified and processed like any other, so it can never credit twice.
 */
export async function adminResendPaymentWebhook(actor: AdminActor, paymentId: string): Promise<AdminResult> {
  const p = await db().payment.findUnique({ where: { id: paymentId }, select: { provider: true, providerPaymentId: true, reference: true } });
  if (!p) return { ok: false, message: "Payment not found." };
  if (p.provider !== CRYPTOMUS_ID) return { ok: false, message: "Only Cryptomus payments support webhook resend." };
  if (!p.providerPaymentId) return { ok: false, message: "This payment has no Cryptomus invoice." };
  const provider = await findPaymentProvider(p.provider);
  if (!(provider instanceof CryptomusPaymentProvider)) return { ok: false, message: "Cryptomus isn't configured." };
  let ok = true;
  let message = "Cryptomus will resend the notification shortly.";
  try {
    await provider.resendWebhook(p.providerPaymentId);
  } catch (error) {
    ok = false;
    message = error instanceof PaymentProviderError ? `Cryptomus refused the resend: ${error.message}` : "Cryptomus couldn't be reached.";
  }
  await audit(actor, "payment.webhook_resend", { type: "payment", id: paymentId }, ok, { reference: p.reference }, ok ? `Requested Cryptomus webhook resend for ${p.reference}` : `Cryptomus webhook resend failed for ${p.reference}`);
  return { ok, message };
}

export type AdminPaymentEventRow = {
  id: string;
  provider: string;
  eventId: string;
  type: string;
  result: string | null;
  error: string | null;
  processedAt: string | null;
  createdAt: string;
  payment: { id: string; reference: string } | null;
};

/** Every received webhook (verified ones; rejected ones are in the system log). */
export async function listPaymentEvents(filter: { provider?: string; q?: string; problems?: boolean; page?: number; pageSize?: number } = {}): Promise<AdminPage<AdminPaymentEventRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 50));
  const q = filter.q?.trim();
  const where: Prisma.PaymentEventWhereInput = {
    ...(filter.provider ? { provider: filter.provider } : {}),
    ...(filter.problems ? { OR: [{ processedAt: null }, { error: { not: null } }] } : {}),
    ...(q ? { AND: [{ OR: [{ eventId: { startsWith: q } }, { payment: { reference: { startsWith: q.toUpperCase() } } }] }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db().paymentEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { payment: { select: { id: true, reference: true } } },
    }),
    db().paymentEvent.count({ where }),
  ]);
  return {
    items: rows.map((e) => ({
      id: e.id,
      provider: e.provider,
      eventId: e.eventId,
      type: e.type,
      result: e.result,
      error: e.error,
      processedAt: e.processedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      payment: e.payment,
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * Closes a "needs review" flag after investigation. It moves no money: any
 * balance correction is made separately with an audited wallet adjustment.
 */
export async function resolvePaymentReview(actor: AdminActor, paymentId: string, note: string): Promise<AdminResult> {
  const text = note.trim();
  if (text.length < 5 || text.length > 300) return { ok: false, message: "Describe the resolution (5–300 characters)." };
  const p = await db().payment.findUnique({ where: { id: paymentId }, select: { needsReview: true, metadata: true } });
  if (!p) return { ok: false, message: "Payment not found." };
  if (!p.needsReview) return { ok: false, message: "This payment isn't flagged for review." };
  const metadata = { ...((p.metadata as Record<string, unknown> | null) ?? {}), review: { by: actor.email, at: new Date().toISOString(), note: text } };
  await db().payment.update({ where: { id: paymentId }, data: { needsReview: false, metadata } });
  await audit(actor, "payment.review_resolved", { type: "payment", id: paymentId }, true, { note: text }, `Closed payment review: ${text}`);
  return { ok: true, message: "Review closed." };
}

/* ------------------------------------------------------------ user extras -- */

export async function userLedger(userId: string, take = 15): Promise<AdminLedgerRow[]> {
  const rows = await db().transaction.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take });
  return rows.map(ledgerRow);
}
