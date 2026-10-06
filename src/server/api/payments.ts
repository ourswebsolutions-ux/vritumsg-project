import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  createTopUp,
  getTopUp,
  getTopUpOptions,
  handlePaymentWebhook,
  listTopUps,
  verifyTopUp,
  type TopUpResult,
} from "@/server/services/payment.service";
import { apiError, json, readJson, withAuth } from "./http";

/**
 * Top-up endpoints. User endpoints need a session or API key and only ever
 * see the caller's own payments; none of them can mark a payment paid or
 * change a balance — only the provider's confirmed state does that.
 */

const HTTP_FOR_PAYMENT_ERROR: Record<Extract<TopUpResult, { ok: false }>["code"], number> = {
  INVALID: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  TOO_MANY_PENDING: 409,
  UNAVAILABLE: 503,
  PROVIDER_ERROR: 502,
};

const paymentResponse = (result: TopUpResult, created = false) =>
  result.ok
    ? json({ payment: result.payment, redirectUrl: result.redirectUrl }, { status: created ? 201 : 200 })
    : apiError(HTTP_FOR_PAYMENT_ERROR[result.code], result.code, result.message);

export const getPaymentOptions = withAuth(async () => json(getTopUpOptions()));

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["all", "pending", "paid", "unpaid"]).default("all"),
});

export const getPayments = withAuth(async (req, { user }) => {
  const q = listQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!q.success) return apiError(400, "INVALID", "Invalid query parameters.");
  return json(await listTopUps(user.id, q.data));
});

const createBody = z.object({
  /** Amount to add to the wallet, as a decimal string ("10.50") or number. */
  amount: z.union([z.string().max(20), z.number().positive().max(1e9)]).transform(String),
  method: z.string().regex(/^[a-z0-9_]{1,32}$/),
  /** Optional provider id ("cryptomus"); see GET /api/payments/options. */
  provider: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
});

export const postPayment = withAuth(async (req, { user }) => {
  const body = createBody.safeParse(await readJson(req));
  if (!body.success) return apiError(400, "INVALID", "Body must include amount and method.");
  const key = body.data.idempotencyKey ?? req.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    return apiError(400, "INVALID", "Provide an Idempotency-Key header (16–64 letters, digits, _ or -).");
  }
  return paymentResponse(await createTopUp(user.id, { amount: body.data.amount, method: body.data.method, provider: body.data.provider, idempotencyKey: key }), true);
});

const idParam = z.uuid();

export const getPaymentById = withAuth<{ id: string }>(async (_req, { user, params }) => {
  if (!idParam.safeParse(params.id).success) return apiError(404, "NOT_FOUND", "Payment not found.");
  const payment = await getTopUp(user.id, params.id);
  return payment ? json({ payment }) : apiError(404, "NOT_FOUND", "Payment not found.");
});

export const postVerifyPayment = withAuth<{ id: string }>(async (_req, { user, params }) => {
  if (!idParam.safeParse(params.id).success) return apiError(404, "NOT_FOUND", "Payment not found.");
  return paymentResponse(await verifyTopUp(user.id, params.id));
});

const MAX_WEBHOOK_BYTES = 64 * 1024;

/** Provider notifications: authenticated by the provider's signature, not by a user session. */
export async function postPaymentWebhook(req: NextRequest, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await ctx.params;
  if (!/^[a-z0-9_-]{1,32}$/.test(provider)) return NextResponse.json({ received: false }, { status: 404 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return NextResponse.json({ received: false }, { status: 413 });
  try {
    const raw = await req.text();
    if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ received: false }, { status: 413 });
    const outcome = await handlePaymentWebhook(provider, raw, req.headers);
    return NextResponse.json(outcome.body, { status: outcome.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[payments] webhook failed:", error instanceof Error ? error.message : "unknown error");
    // 5xx makes the provider redeliver; processing is idempotent.
    return NextResponse.json({ received: false }, { status: 500 });
  }
}
