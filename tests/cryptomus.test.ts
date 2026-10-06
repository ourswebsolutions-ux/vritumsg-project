import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminActor } from "@/server/admin/guard";
import { getCryptomusSettings, saveCryptomusSettings, testCryptomusConnection, type CryptomusSettingsInput } from "@/server/admin/payment-settings";
import { postPaymentWebhook } from "@/server/api/payments";
import { db } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { loadCryptomusConfig } from "@/server/payments/cryptomus/config";
import { mapStatus } from "@/server/payments/cryptomus/provider";
import { phpJsonEncode, signBody, verifyWebhookSignature } from "@/server/payments/cryptomus/signature";
import { setPaymentProviderForTesting } from "@/server/payments/registry";
import { approveManualTopUp, createManualTopUp, createTopUp, getTopUpOptions, handlePaymentWebhook } from "@/server/services/payment.service";
import { clearSettingsCache, getSetting, saveSetting } from "@/server/services/settings.service";
import { getBalance } from "@/server/services/wallet.service";
import { createUser, resetDatabase, USD } from "./helpers";

/**
 * Cryptomus end to end against a local HTTP stand-in that implements the
 * documented API (doc.cryptomus.com): POST + `merchant` / `sign` headers,
 * sign = md5(base64(body) + API key), `{ state: 0, result }` answers, and
 * webhooks signed over PHP json_encode of the payload. No mocked service
 * functions: every request goes through the real client over HTTP.
 */

const MERCHANT = "c26b80a8-9549-4b2e-a3d5-0e2b5b8bd4f0";
const PAYMENT_KEY = "tGq5Zk1pXyW8vN3rLm2Hs7Jd4Fb6Ce9Ua0Qo";
const OTHER_KEY = "wrongKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type Invoice = { uuid: string; order_id: string; amount: string; currency: string; payment_status: string; url_callback: string; lifetime: number };
const invoices = new Map<string, Invoice>();
const requests: { path: string; merchant: string | undefined; signOk: boolean; body: Record<string, unknown> }[] = [];
let server: Server;
let apiUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const signOk = req.headers.merchant === MERCHANT && req.headers.sign === signBody(raw, PAYMENT_KEY);
      requests.push({ path: req.url ?? "", merchant: req.headers.merchant as string | undefined, signOk, body });
      if (req.method !== "POST") return send(405, { state: 1, message: "Method not allowed" });
      if (!signOk) return send(401, { state: 1, message: "Unauthorized" });
      const view = (i: Invoice) => ({
        uuid: i.uuid,
        order_id: i.order_id,
        amount: i.amount,
        payment_amount: i.payment_status === "paid_over" ? "12.0" : i.payment_status === "wrong_amount" ? "5.0" : i.payment_status.startsWith("paid") ? i.amount : null,
        payer_amount: null,
        currency: i.currency,
        payer_currency: "USDT",
        merchant_amount: null,
        network: "tron",
        address: null,
        txid: i.payment_status.startsWith("paid") || i.payment_status === "wrong_amount" ? "a1b2c3d4e5" : null,
        payment_status: i.payment_status,
        status: i.payment_status,
        url: `https://pay.cryptomus.com/pay/${i.uuid}`,
        expired_at: Math.floor(Date.now() / 1000) + i.lifetime,
        is_final: ["paid", "paid_over", "wrong_amount", "fail", "cancel", "system_fail", "refund_paid"].includes(i.payment_status),
        commission: "0.02",
      });
      switch (req.url) {
        case "/v1/payment": {
          if (!/^\d+(\.\d+)?$/.test(String(body.amount))) return send(422, { state: 1, errors: { amount: ["The amount is invalid."] } });
          const existing = [...invoices.values()].find((i) => i.order_id === body.order_id);
          if (existing) return send(200, { state: 0, result: view(existing) }); // Cryptomus returns the same invoice for a repeated order_id
          const inv: Invoice = {
            uuid: randomUUID(),
            order_id: String(body.order_id),
            amount: String(body.amount),
            currency: String(body.currency),
            payment_status: "check",
            url_callback: String(body.url_callback),
            lifetime: Number(body.lifetime ?? 3600),
          };
          invoices.set(inv.uuid, inv);
          return send(200, { state: 0, result: view(inv) });
        }
        case "/v1/payment/info": {
          const inv = body.uuid ? invoices.get(String(body.uuid)) : [...invoices.values()].find((i) => i.order_id === body.order_id);
          return inv ? send(200, { state: 0, result: view(inv) }) : send(404, { state: 1, message: "Payment not found" });
        }
        case "/v1/payment/services":
          return send(200, {
            state: 0,
            result: [
              { network: "tron", currency: "USDT", is_available: true, limit: { min_amount: "1", max_amount: "10000" }, commission: { fee_amount: "0", percent: "0.4" } },
              { network: "btc", currency: "BTC", is_available: true, limit: { min_amount: "5", max_amount: "10000" }, commission: { fee_amount: "0", percent: "0.4" } },
            ],
          });
        case "/v2/payment/resend": {
          const inv = invoices.get(String(body.uuid));
          if (!inv) return send(404, { state: 1, message: "Payment not found" });
          return ["paid", "paid_over", "wrong_amount"].includes(inv.payment_status) ? send(200, { state: 0, result: [] }) : send(422, { state: 1, message: "Payment is not finalized" });
        }
        default:
          return send(404, { state: 1, message: "Not found" });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db().$disconnect();
});

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

const ENV = {
  CRYPTOMUS_API_URL: () => apiUrl,
  CRYPTOMUS_MERCHANT_ID: () => MERCHANT,
  CRYPTOMUS_PAYMENT_API_KEY: () => PAYMENT_KEY,
};

async function enable(over: Partial<Awaited<ReturnType<typeof getSetting<"payment_cryptomus">>>> = {}) {
  await saveSetting("payment_cryptomus", { ...(await getSetting("payment_cryptomus")), enabled: true, ...over });
}

beforeEach(async () => {
  await resetDatabase();
  clearSettingsCache();
  invoices.clear();
  requests.length = 0;
  setPaymentProviderForTesting(undefined);
  setEnv({
    PAYMENT_PROVIDER: "none",
    CRYPTOMUS_API_URL: ENV.CRYPTOMUS_API_URL(),
    CRYPTOMUS_MERCHANT_ID: ENV.CRYPTOMUS_MERCHANT_ID(),
    CRYPTOMUS_PAYMENT_API_KEY: ENV.CRYPTOMUS_PAYMENT_API_KEY(),
    CRYPTOMUS_PAYOUT_API_KEY: undefined,
    CRYPTOMUS_WEBHOOK_URL: undefined,
    SETTINGS_ENCRYPTION_KEY: "q2sN0cVd8h3y6l1Hk9mXo4tRb7aEw5zP1u3iJ8fG2cQ=",
  });
  await enable();
});
afterEach(() => {
  setEnv({ PAYMENT_PROVIDER: "none", CRYPTOMUS_MERCHANT_ID: undefined, CRYPTOMUS_PAYMENT_API_KEY: undefined, SETTINGS_ENCRYPTION_KEY: undefined });
  clearSettingsCache();
});

const key = () => `k${Math.random().toString(36).slice(2)}${Date.now()}`.padEnd(20, "0");
const topUp = (userId: string, amount = "10") => createTopUp(userId, { amount, method: "crypto", provider: "cryptomus", idempotencyKey: key() });

async function invoice(amount = "10") {
  const user = await createUser();
  const r = await topUp(user.id, amount);
  if (!r.ok) throw new Error(r.message);
  const row = await db().payment.findUniqueOrThrow({ where: { id: r.payment.id } });
  return { user, row, inv: invoices.get(row.providerPaymentId!)! };
}

/** A webhook exactly as Cryptomus sends it (signed over PHP json_encode of the payload). */
function webhookBody(inv: Invoice, status: string, apiKey = PAYMENT_KEY, extra: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = {
    type: "payment",
    uuid: inv.uuid,
    order_id: inv.order_id,
    amount: inv.amount,
    payment_amount: inv.amount,
    payment_amount_usd: inv.amount,
    merchant_amount: inv.amount,
    commission: "0.02",
    is_final: true,
    status,
    from: null,
    wallet_address_uuid: null,
    network: "tron",
    currency: inv.currency,
    payer_currency: "USDT",
    additional_data: "VirtuMSG top-up https://example.test/a/b — ок",
    convert: null,
    txid: "a1b2c3d4e5",
    ...extra,
  };
  const sign = signBody(phpJsonEncode(payload), apiKey);
  return JSON.stringify({ ...payload, sign }).replace(/\//g, "\\/"); // PHP escapes slashes on the wire too
}

/** The provider changes the invoice status, then notifies us. */
async function notify(inv: Invoice, status: string, opts: { apiKey?: string; extra?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  inv.payment_status = status;
  return handlePaymentWebhook("cryptomus", webhookBody(inv, status, opts.apiKey, opts.extra), new Headers(opts.headers ?? {}));
}

const safeJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
const credits = (paymentId: string) => db().transaction.count({ where: { paymentId, type: "DEPOSIT" } });
const status = async (paymentId: string) => (await db().payment.findUniqueOrThrow({ where: { id: paymentId } })).status;

async function adminActor(): Promise<AdminActor> {
  const u = await createUser();
  await db().user.update({ where: { id: u.id }, data: { role: "ADMIN" } });
  return { id: u.id, email: u.email, name: u.name, sessionId: "test" };
}

describe("signatures (doc.cryptomus.com)", () => {
  it("signs requests as md5(base64(body) + key) and verifies webhooks over PHP json_encode", () => {
    expect(signBody("{}", "k")).toBe("17cc27615060579b99f3d5921adfeceb"); // md5("e30=" + "k")
    const inv: Invoice = { uuid: randomUUID(), order_id: "TP-ABC", amount: "10.00", currency: "USD", payment_status: "paid", url_callback: "", lifetime: 3600 };
    const body = webhookBody(inv, "paid");
    expect(verifyWebhookSignature(body, PAYMENT_KEY)).toMatchObject({ uuid: inv.uuid, status: "paid" });
    expect(verifyWebhookSignature(body, OTHER_KEY)).toBeNull();
    expect(verifyWebhookSignature(body.replace('"10.00"', '"99.00"'), PAYMENT_KEY)).toBeNull(); // tampered
    expect(verifyWebhookSignature("not json", PAYMENT_KEY)).toBeNull();
  });

  it("maps every documented status; only paid / paid_over credit", () => {
    expect(["paid", "paid_over"].map(mapStatus)).toEqual(["paid", "paid"]);
    expect(mapStatus("wrong_amount")).toBe("underpaid");
    expect(["process", "confirm_check", "wrong_amount_waiting", "locked"].map(mapStatus)).toEqual(Array(4).fill("processing"));
    expect(["fail", "system_fail"].map(mapStatus)).toEqual(["failed", "failed"]);
    expect(mapStatus("cancel")).toBe("cancelled");
    expect(["check", "refund_process", "refund_fail", "something_new"].map(mapStatus)).toEqual(Array(4).fill("pending"));
    expect(mapStatus("refund_paid")).toBe("refunded");
  });
});

describe("creating invoices", () => {
  it("1. creates a signed invoice with our order ID and returns the hosted payment URL", async () => {
    const user = await createUser();
    const r = await topUp(user.id, "12.5");
    expect(r).toMatchObject({ ok: true, payment: { status: "pending", provider: "cryptomus", method: "crypto" } });
    if (!r.ok) return;
    expect(r.redirectUrl).toMatch(/^https:\/\/pay\.cryptomus\.com\/pay\//);
    const create = requests.find((q) => q.path === "/v1/payment")!;
    expect(create.signOk).toBe(true);
    expect(create.body).toMatchObject({
      amount: "12.50",
      currency: "USD",
      order_id: r.payment.reference,
      url_callback: "http://localhost:3000/api/payments/webhook/cryptomus",
      lifetime: 3600,
    });
    expect(String(create.body.url_return)).toContain(`/profile/top-up/${r.payment.id}`);
    // Nothing is credited by creating an invoice.
    expect((await getBalance(user.id)).balance).toBe(0);
  });

  it("2. invalid API credentials: no invoice, a safe message, the error recorded for staff", async () => {
    setEnv({ CRYPTOMUS_PAYMENT_API_KEY: OTHER_KEY });
    const user = await createUser();
    const r = await topUp(user.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).not.toContain(OTHER_KEY);
    expect(invoices.size).toBe(0);
    const row = await db().payment.findFirstOrThrow({ where: { userId: user.id } });
    expect(["FAILED", "PENDING"]).toContain(row.status);
    expect(JSON.stringify(row.metadata)).not.toContain(OTHER_KEY);
  });

  it("3–5. validates the amount format and the admin's min / max on the server", async () => {
    await enable({ minAmount: "5", maxAmount: "50" });
    const user = await createUser();
    for (const bad of ["abc", "-1", "10.555", "0"]) expect(await topUp(user.id, bad)).toMatchObject({ ok: false, code: "INVALID" });
    expect(await topUp(user.id, "4.99")).toMatchObject({ ok: false, message: "Enter an amount between 5 and 50 USD." });
    expect(await topUp(user.id, "50.01")).toMatchObject({ ok: false, message: "Enter an amount between 5 and 50 USD." });
    expect(await topUp(user.id, "5")).toMatchObject({ ok: true });
    expect(await topUp(user.id, "50")).toMatchObject({ ok: true });
    expect(invoices.size).toBe(2);
  });

  it("adds the admin's fees to the invoice and credits only the chosen amount", async () => {
    await enable({ feePercent: "2", feeFixed: "0.5" });
    const { user, row, inv } = await invoice("10");
    expect(inv.amount).toBe("10.70");
    expect(row.total.toString()).toBe("10.7");
    await notify(inv, "paid");
    expect((await getBalance(user.id)).balance).toBe(USD(10));
  });
});

describe("webhooks", () => {
  it("6. a verified paid webhook credits the wallet once, with a ledger entry", async () => {
    const { user, row, inv } = await invoice("10");
    expect(await notify(inv, "paid")).toMatchObject({ status: 200 });
    expect(await status(row.id)).toBe("PAID");
    expect((await getBalance(user.id)).balance).toBe(USD(10));
    const tx = await db().transaction.findFirstOrThrow({ where: { paymentId: row.id } });
    expect(tx).toMatchObject({ type: "DEPOSIT", reference: `payment:${row.id}:credit`, description: `Top-up · Cryptomus · ${row.reference}` });
    expect(tx.metadata).toMatchObject({ provider: "cryptomus", providerPaymentId: inv.uuid, orderId: row.reference, txid: "a1b2c3d4e5", network: "tron" });
    const event = await db().paymentEvent.findFirstOrThrow({ where: { paymentId: row.id } });
    expect(event).toMatchObject({ provider: "cryptomus", eventId: `${inv.uuid}:paid`, result: "payment_paid" });
    // The payment record keeps the provider details for staff.
    expect((await db().payment.findUniqueOrThrow({ where: { id: row.id } })).metadata).toMatchObject({ provider: { network: "tron", txid: "a1b2c3d4e5", providerStatus: "paid" } });
  });

  it("goes through the real route: POST /api/payments/webhook/cryptomus", async () => {
    const { user, inv } = await invoice("10");
    inv.payment_status = "paid";
    const res = await postPaymentWebhook(
      new NextRequest("http://localhost/api/payments/webhook/cryptomus", { method: "POST", body: webhookBody(inv, "paid") }),
      { params: Promise.resolve({ provider: "cryptomus" }) },
    );
    expect(res.status).toBe(200);
    expect((await getBalance(user.id)).balance).toBe(USD(10));
  });

  it("7. rejects an invalid signature and credits nothing (logged, no event stored)", async () => {
    const { user, row, inv } = await invoice("10");
    expect(await notify(inv, "paid", { apiKey: OTHER_KEY })).toMatchObject({ status: 401 });
    const unsigned = JSON.stringify({ type: "payment", uuid: inv.uuid, order_id: inv.order_id, status: "paid", amount: "10.00", currency: "USD" });
    expect(await handlePaymentWebhook("cryptomus", unsigned, new Headers())).toMatchObject({ status: 401 });
    expect((await getBalance(user.id)).balance).toBe(0);
    expect(await credits(row.id)).toBe(0);
    expect(await db().paymentEvent.count()).toBe(0);
    expect(await db().systemLog.count({ where: { message: "webhook_rejected" } })).toBeGreaterThanOrEqual(2);
  });

  it("does not trust the webhook body: the status is confirmed with the Cryptomus API", async () => {
    const { user, row, inv } = await invoice("10");
    // Correctly signed "paid", but the invoice is still unpaid at Cryptomus.
    const r = await handlePaymentWebhook("cryptomus", webhookBody(inv, "paid"), new Headers());
    expect(r.status).toBe(200);
    expect(await status(row.id)).toBe("PENDING");
    expect((await getBalance(user.id)).balance).toBe(0);
    expect(requests.some((q) => q.path === "/v1/payment/info" && q.body.uuid === inv.uuid && q.signOk)).toBe(true);
  });

  it("8 & 15. duplicate and resent webhooks never credit twice", async () => {
    const { user, row, inv } = await invoice("10");
    await notify(inv, "paid");
    for (let i = 0; i < 3; i++) expect(await notify(inv, "paid")).toMatchObject({ status: 200 });
    // A later paid_over notification for the same, already completed invoice.
    await notify(inv, "paid_over");
    expect(await credits(row.id)).toBe(1);
    expect((await getBalance(user.id)).balance).toBe(USD(10));
    expect(await db().paymentEvent.count({ where: { paymentId: row.id, eventId: `${inv.uuid}:paid` } })).toBe(1);
  });

  it("20. concurrent deliveries of the same paid webhook credit exactly once", async () => {
    const { user, row, inv } = await invoice("10");
    inv.payment_status = "paid";
    const body = webhookBody(inv, "paid");
    const results = await Promise.all(Array.from({ length: 8 }, () => handlePaymentWebhook("cryptomus", body, new Headers()).catch(() => ({ status: 500 }))));
    expect(results.some((r) => r.status === 200)).toBe(true);
    // Any delivery that lost the race is redelivered and is then a no-op.
    await handlePaymentWebhook("cryptomus", body, new Headers());
    expect(await credits(row.id)).toBe(1);
    expect((await getBalance(user.id)).balance).toBe(USD(10));
  });

  it("9. an unknown order ID is recorded and never credits anyone", async () => {
    const { user, inv } = await invoice("10");
    const ghost: Invoice = { ...inv, uuid: randomUUID(), order_id: "TP-DOESNOTEXIST" };
    expect(await notify(ghost, "paid")).toMatchObject({ status: 200 });
    expect(await db().paymentEvent.findFirstOrThrow({ where: { eventId: `${ghost.uuid}:paid` } })).toMatchObject({ result: "unknown_payment", paymentId: null });
    expect((await getBalance(user.id)).balance).toBe(0);
    expect(await db().transaction.count()).toBe(0);
  });

  it("10. a paid invoice whose amount doesn't match is flagged, not credited", async () => {
    const { user, row, inv } = await invoice("10");
    inv.amount = "100.00"; // the provider reports a different invoice amount
    await notify(inv, "paid");
    const p = await db().payment.findUniqueOrThrow({ where: { id: row.id } });
    expect(p).toMatchObject({ needsReview: true, failureReason: "AMOUNT_MISMATCH" });
    expect(p.status).not.toBe("PAID");
    expect((await getBalance(user.id)).balance).toBe(0);
  });

  it("11. underpayment (wrong_amount) is final, flagged and never credited", async () => {
    const { user, row, inv } = await invoice("10");
    await notify(inv, "wrong_amount_waiting");
    expect(await status(row.id)).toBe("PROCESSING");
    await notify(inv, "wrong_amount");
    expect(await db().payment.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "UNDERPAID", needsReview: true, failureReason: "UNDERPAID" });
    expect((await getBalance(user.id)).balance).toBe(0);
  });

  it("12. overpayment (paid_over) credits the invoice amount once and flags the difference for review", async () => {
    const { user, row, inv } = await invoice("10");
    await notify(inv, "paid_over");
    expect(await db().payment.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "PAID", needsReview: true, failureReason: "OVERPAID" });
    expect((await getBalance(user.id)).balance).toBe(USD(10));
  });

  it("13 & 14. failed and cancelled payments close the top-up without credit", async () => {
    const a = await invoice("10");
    await notify(a.inv, "fail");
    expect(await status(a.row.id)).toBe("FAILED");
    const b = await invoice("10");
    await notify(b.inv, "cancel");
    expect(await status(b.row.id)).toBe("CANCELLED");
    const c = await invoice("10");
    await notify(c.inv, "system_fail");
    expect(await status(c.row.id)).toBe("FAILED");
    expect(await db().transaction.count()).toBe(0);
  });

  it("ignores wallet (non-payment) webhooks", async () => {
    const { inv } = await invoice("10");
    inv.payment_status = "paid";
    const r = await handlePaymentWebhook("cryptomus", webhookBody(inv, "paid", PAYMENT_KEY, { type: "wallet" }), new Headers());
    expect(r.status).toBe(400);
    expect(await db().transaction.count()).toBe(0);
  });

  it("optionally restricts webhooks to Cryptomus' IP (behind a trusted proxy)", async () => {
    await enable({ verifyIp: true });
    setEnv({ TRUST_PROXY: "true" });
    try {
      const { user, inv } = await invoice("10");
      expect(await notify(inv, "paid", { headers: { "x-forwarded-for": "203.0.113.9" } })).toMatchObject({ status: 401 });
      expect(await notify(inv, "paid", { headers: { "x-forwarded-for": "91.227.144.54" } })).toMatchObject({ status: 200 });
      expect((await getBalance(user.id)).balance).toBe(USD(10));
    } finally {
      setEnv({ TRUST_PROXY: "false" });
    }
  });
});

describe("enabling and disabling", () => {
  it("16. disabled: hidden from users and no new invoices, but existing invoices still settle", async () => {
    const { user, row, inv } = await invoice("10");
    await enable({ enabled: false });
    const options = await getTopUpOptions();
    expect(options.providers.map((p) => p.id)).not.toContain("cryptomus");
    expect(await topUp(user.id)).toMatchObject({ ok: false });
    expect(invoices.size).toBe(1);
    await notify(inv, "paid");
    expect(await status(row.id)).toBe("PAID");
    expect((await getBalance(user.id)).balance).toBe(USD(10));
  });

  it("is offered next to manual payments, in the admin's order", async () => {
    setEnv({ PAYMENT_PROVIDER: "manual" });
    await enable({ sortOrder: 10 });
    const o = await getTopUpOptions();
    expect(o.providers.map((p) => p.id)).toEqual(["manual", "cryptomus"]);
    expect(o.providers[1]).toMatchObject({ flow: "redirect", min: USD(1), max: USD(1000), methods: [{ id: "crypto", kind: "crypto" }] });
    // Nothing secret reaches the options sent to the browser.
    const json = JSON.stringify(o);
    for (const secret of [PAYMENT_KEY, MERCHANT]) expect(json).not.toContain(secret);
  });
});

describe("18 & 19. manual Easypaisa / JazzCash keep working alongside Cryptomus", () => {
  it.each(["easypaisa", "jazzcash"])("%s request → admin approval credits once", async (method) => {
    setEnv({ PAYMENT_PROVIDER: "manual" });
    const user = await createUser();
    const r = await createManualTopUp(user.id, { amount: "10", method, transactionId: `TID${Date.now()}${method.length}`, idempotencyKey: key() });
    expect(r).toMatchObject({ ok: true, payment: { status: "pending", provider: "manual", method } });
    if (!r.ok) return;
    const admin = await adminActor();
    await approveManualTopUp(admin, r.payment.id);
    await approveManualTopUp(admin, r.payment.id);
    expect((await getBalance(user.id)).balance).toBe(USD(10));
    expect(await credits(r.payment.id)).toBe(1);
    expect(invoices.size).toBe(0);
  });
});

describe("17. admin credentials", () => {
  const form = (over: Partial<CryptomusSettingsInput> = {}): CryptomusSettingsInput => ({
    enabled: true,
    merchantId: { value: "", clear: false },
    paymentKey: { value: "", clear: false },
    payoutKey: { value: "", clear: false },
    displayName: "Crypto (Cryptomus)",
    description: "",
    minAmount: "1",
    maxAmount: "1000",
    feeFixed: "0",
    feePercent: "0",
    sortOrder: "10",
    webhookUrl: "",
    verifyIp: false,
    lifetimeMinutes: "60",
    ...over,
  });

  it("stores credentials encrypted, shows only a mask, keeps them when left blank, and they take priority over env", async () => {
    setEnv({ CRYPTOMUS_MERCHANT_ID: undefined, CRYPTOMUS_PAYMENT_API_KEY: OTHER_KEY });
    const admin = await adminActor();
    const payout = "PayoutKeyZZZZZZZZZZZZZZZZZZZZ9876";
    expect(
      await saveCryptomusSettings(admin, form({ merchantId: { value: MERCHANT, clear: false }, paymentKey: { value: PAYMENT_KEY, clear: false }, payoutKey: { value: payout, clear: false } })),
    ).toMatchObject({ ok: true });

    const stored = JSON.stringify((await db().setting.findUniqueOrThrow({ where: { key: "payment_cryptomus" } })).value);
    for (const secret of [MERCHANT, PAYMENT_KEY, payout]) expect(stored).not.toContain(secret);
    const view = await getCryptomusSettings();
    expect(view.masked).toEqual({ merchantId: `${"*".repeat(16)}d4f0`, paymentKey: `${"*".repeat(16)}a0Qo`, payoutKey: `${"*".repeat(16)}9876` });
    expect(view.sources).toEqual({ merchantId: "admin", paymentKey: "admin", payoutKey: "admin" });
    const viewJson = JSON.stringify(view);
    for (const secret of [MERCHANT, PAYMENT_KEY, payout]) expect(viewJson).not.toContain(secret);
    // Admin key wins over the (wrong) environment key: invoices work.
    expect(await topUp((await createUser()).id)).toMatchObject({ ok: true });

    // Saving again with blank credential fields keeps them.
    expect(await saveCryptomusSettings(admin, form({ displayName: "Pay with crypto" }))).toMatchObject({ ok: true });
    const config = await loadCryptomusConfig();
    expect(config).toMatchObject({ paymentKeyPlain: PAYMENT_KEY, merchantIdPlain: MERCHANT, payoutKeyPlain: payout, displayName: "Pay with crypto" });

    // The audit log names what changed, never the values.
    const logs = safeJson(await db().auditLog.findMany({ where: { action: "payment_cryptomus.update" } }));
    expect(logs).toContain("paymentKey:replaced");
    for (const secret of [MERCHANT, PAYMENT_KEY, payout]) expect(logs).not.toContain(secret);

    // Clearing falls back to the environment.
    expect(await saveCryptomusSettings(admin, form({ enabled: false, paymentKey: { value: "", clear: true } }))).toMatchObject({ ok: true });
    expect(await loadCryptomusConfig()).toMatchObject({ paymentKeyPlain: OTHER_KEY, sources: { paymentKey: "env" } });
  });

  it("validates input and refuses to enable without credentials or to save secrets without an encryption key", async () => {
    setEnv({ CRYPTOMUS_MERCHANT_ID: undefined, CRYPTOMUS_PAYMENT_API_KEY: undefined });
    const admin = await adminActor();
    expect(await saveCryptomusSettings(admin, form())).toMatchObject({ ok: false, message: expect.stringContaining("before enabling") });
    expect(await saveCryptomusSettings(admin, form({ merchantId: { value: "not-a-uuid", clear: false } }))).toMatchObject({ ok: false });
    expect(await saveCryptomusSettings(admin, form({ enabled: false, minAmount: "50", maxAmount: "10" }))).toMatchObject({ ok: false });
    setEnv({ SETTINGS_ENCRYPTION_KEY: undefined });
    expect(await saveCryptomusSettings(admin, form({ paymentKey: { value: PAYMENT_KEY, clear: false } }))).toMatchObject({
      ok: false,
      message: expect.stringContaining("SETTINGS_ENCRYPTION_KEY"),
    });
    expect((await getSetting("payment_cryptomus")).paymentKey).toBeNull();
  });

  it("tests the connection with a signed read-only request and a fixed message", async () => {
    const admin = await adminActor();
    expect(await testCryptomusConnection(admin)).toEqual({ ok: true, message: "Cryptomus connection successful. 2 payment options available." });
    expect(await testCryptomusConnection(admin, { paymentKey: OTHER_KEY })).toEqual({ ok: false, message: "Cryptomus connection failed. Please verify Merchant ID/API key." });
    expect(invoices.size).toBe(0);
    expect(safeJson(await db().auditLog.findMany())).not.toContain(OTHER_KEY);
  });
});
