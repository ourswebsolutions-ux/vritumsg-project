import "server-only";
import { parseAmount, toDecimalString } from "@/lib/money";
import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type CreatedPayment,
  type PaymentMethodInfo,
  type PaymentProvider,
  type ProviderPaymentState,
  type VerifiedWebhook,
} from "../types";
import { CryptomusClient } from "./client";
import { CRYPTOMUS_ID, CRYPTOMUS_METHOD, type CryptomusConfig } from "./config";
import { verifyWebhookSignature } from "./signature";
import { env } from "@/server/env";

/**
 * Cryptomus as a top-up gateway ("redirect" flow): we create an invoice,
 * the customer pays on Cryptomus' hosted page, and the payment is credited
 * only after its state is read back from Cryptomus (webhook = a signed hint,
 * then POST /v1/payment/info). Statuses: doc.cryptomus.com → Payment statuses.
 */

/** Cryptomus' published webhook source address. */
export const CRYPTOMUS_WEBHOOK_IP = "91.227.144.54";

/** Invoice fields we read (subset of the documented response). */
export type CryptomusInvoice = {
  uuid: string;
  order_id: string | null;
  amount: string;
  currency: string;
  url?: string;
  expired_at?: number | null;
  status?: string;
  payment_status?: string;
  is_final?: boolean;
  payment_amount?: string | null;
  payer_amount?: string | null;
  payer_currency?: string | null;
  merchant_amount?: string | null;
  network?: string | null;
  txid?: string | null;
  commission?: string | null;
  updated_at?: string | null;
};

export type CryptomusService = {
  network: string;
  currency: string;
  is_available: boolean;
  limit: { min_amount: string; max_amount: string };
  commission: { fee_amount: string; percent: string };
};

/** Every documented status → our normalized state. Only paid / paid_over credit a wallet. */
const STATUS: Record<string, ProviderPaymentState["status"]> = {
  paid: "paid",
  paid_over: "paid",
  wrong_amount: "underpaid", // final: paid less than required
  check: "pending", // waiting for the transaction to appear
  process: "processing",
  confirm_check: "processing", // seen on chain, waiting for confirmations
  wrong_amount_waiting: "processing", // underpaid, the customer may still pay the rest
  locked: "processing", // funds locked by AML checks — not credited
  fail: "failed",
  system_fail: "failed",
  cancel: "cancelled", // the customer did not pay in time
  refund_process: "pending", // no change on our side while a refund runs
  refund_fail: "pending",
  refund_paid: "refunded",
};

export function mapStatus(status: string | undefined): ProviderPaymentState["status"] {
  return (status && STATUS[status]) || "pending";
}

export function invoiceToState(inv: CryptomusInvoice): ProviderPaymentState {
  const providerStatus = inv.payment_status ?? inv.status ?? "unknown";
  const amount = parseAmount(String(inv.amount));
  if (amount === null) throw new PaymentProviderError("INVALID_PAYLOAD", "Cryptomus invoice without a valid amount", CRYPTOMUS_ID);
  return {
    providerPaymentId: inv.uuid,
    status: mapStatus(providerStatus),
    amount,
    currency: String(inv.currency).toUpperCase(),
    reference: inv.order_id ?? null,
    overpaid: providerStatus === "paid_over",
    details: {
      providerStatus,
      isFinal: inv.is_final ?? null,
      paymentAmount: inv.payment_amount ?? null,
      payerAmount: inv.payer_amount ?? null,
      payerCurrency: inv.payer_currency ?? null,
      merchantAmount: inv.merchant_amount ?? null,
      network: inv.network ?? null,
      txid: inv.txid ?? null,
      commission: inv.commission ?? null,
      providerUpdatedAt: inv.updated_at ?? null,
    },
  };
}

export class CryptomusPaymentProvider implements PaymentProvider {
  readonly id = CRYPTOMUS_ID;
  readonly live = true;
  readonly flow = "redirect" as const;
  readonly label: string;
  private readonly payments: CryptomusClient;

  constructor(
    private readonly config: CryptomusConfig,
    private readonly baseUrl: string,
  ) {
    if (!config.merchantIdPlain || !config.paymentKeyPlain) throw new PaymentProviderError("NOT_CONFIGURED", "Cryptomus is not configured", CRYPTOMUS_ID);
    this.label = config.displayName;
    // Accepting payments uses the PAYMENT key only (payouts would need a separate client with the payout key).
    this.payments = new CryptomusClient({ baseUrl, merchantId: config.merchantIdPlain, apiKey: config.paymentKeyPlain });
  }

  methods(): PaymentMethodInfo[] {
    return [{ id: CRYPTOMUS_METHOD, label: this.config.displayName, description: this.config.description || undefined, kind: "crypto" }];
  }

  async createPayment(req: CreatePaymentRequest): Promise<CreatedPayment> {
    const lifetime = Math.min(43_200, Math.max(300, Math.round((req.expiresAt.getTime() - Date.now()) / 1000)));
    const inv = await this.payments.post<CryptomusInvoice>("/v1/payment", {
      amount: toDecimalString(req.amount).replace(/(\.\d\d)\d*$/, "$1"), // invoice amount, "12.50"
      currency: req.currency,
      order_id: req.reference, // our unique reference (letters, digits, "-")
      url_return: req.returnUrl,
      url_success: req.returnUrl, // our status page reads the real state; it is never proof of payment
      url_callback: this.config.effectiveWebhookUrl, // admin override → CRYPTOMUS_WEBHOOK_URL → APP_URL default
      lifetime,
      additional_data: req.description.slice(0, 255),
    });
    if (!inv?.uuid || !inv.url) throw new PaymentProviderError("INVALID_PAYLOAD", "Cryptomus invoice without uuid/url", CRYPTOMUS_ID);
    return { providerPaymentId: inv.uuid, checkoutUrl: inv.url, expiresAt: inv.expired_at ? new Date(inv.expired_at * 1000) : null };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPaymentState> {
    return invoiceToState(await this.payments.post<CryptomusInvoice>("/v1/payment/info", { uuid: providerPaymentId }));
  }

  async findPaymentByReference(reference: string): Promise<ProviderPaymentState | null> {
    try {
      return invoiceToState(await this.payments.post<CryptomusInvoice>("/v1/payment/info", { order_id: reference }));
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  verifyWebhook(rawBody: string, headers: Headers): VerifiedWebhook {
    // Optional extra check; the client IP is only trustworthy behind a proxy that sets it (TRUST_PROXY).
    // The signature below is always required.
    if (this.config.verifyIp && env().TRUST_PROXY) {
      const ip = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || headers.get("x-real-ip") || "";
      if (ip !== CRYPTOMUS_WEBHOOK_IP) throw new PaymentProviderError("INVALID_SIGNATURE", "webhook from an unexpected IP", CRYPTOMUS_ID);
    }
    const data = verifyWebhookSignature(rawBody, this.config.paymentKeyPlain!);
    if (!data) throw new PaymentProviderError("INVALID_SIGNATURE", "bad Cryptomus signature", CRYPTOMUS_ID);
    const uuid = typeof data.uuid === "string" ? data.uuid : null;
    const orderId = typeof data.order_id === "string" ? data.order_id : null;
    const status = typeof data.status === "string" ? data.status : "unknown";
    if (data.type !== "payment" || (!uuid && !orderId)) throw new PaymentProviderError("INVALID_PAYLOAD", "not a payment webhook", CRYPTOMUS_ID);
    // One event per invoice status: a resent/duplicated webhook for the same status is recognised.
    return { eventId: `${uuid ?? orderId}:${status}`.slice(0, 191), type: status, providerPaymentId: uuid, reference: orderId };
  }

  /** Admin "Test connection": a signed, read-only request (list of payment services). */
  async listServices(): Promise<CryptomusService[]> {
    return this.payments.post<CryptomusService[]>("/v1/payment/services", {});
  }

  /** Asks Cryptomus to send the webhook of a FINALIZED invoice again (paid, paid_over, wrong_amount). */
  async resendWebhook(providerPaymentId: string): Promise<void> {
    await this.payments.post("/v2/payment/resend", { uuid: providerPaymentId });
  }
}
