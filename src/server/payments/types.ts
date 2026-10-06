/**
 * Payment-provider contract for wallet top-ups. Everything provider-specific
 * (API calls, signatures, status vocabularies) lives behind this interface;
 * the payment service and the wallet never see provider formats.
 */

export type PaymentMethodKind = "card" | "bank_transfer" | "local" | "crypto" | "wallet" | "test";

export type PaymentMethodInfo = {
  /** Stable id stored on the payment, e.g. "card". */
  id: string;
  label: string;
  description?: string;
  kind: PaymentMethodKind;
};

/** The provider's view of one payment, normalized. */
export type ProviderPaymentState = {
  providerPaymentId: string;
  /**
   * "underpaid": final, the customer paid less than the invoice — never
   * credited automatically (flagged for staff).
   */
  status: "pending" | "processing" | "paid" | "underpaid" | "failed" | "cancelled" | "expired" | "refunded";
  /** Amount the provider collected/expects, integer minor units (1/10,000). */
  amount: number;
  currency: string;
  /** Our payment reference as echoed by the provider, when it keeps one. */
  reference: string | null;
  /** Paid, but more than the invoice (credited the invoice amount; staff can review the difference). */
  overpaid?: boolean;
  /**
   * Non-secret provider details kept for support (status, network, transaction
   * hash, paid amount…). Never credentials or personal payment data.
   */
  details?: Record<string, string | boolean | null>;
};

export type CreatePaymentRequest = {
  /** Our unique reference (also the provider-side idempotency key). */
  reference: string;
  /** Total to charge (amount + fee), minor units. */
  amount: number;
  currency: string;
  method: string;
  description: string;
  /** Where the provider sends the customer afterwards (never proof of payment). */
  returnUrl: string;
  /** Where the provider posts status notifications. */
  webhookUrl: string;
  expiresAt: Date;
};

export type CreatedPayment = {
  providerPaymentId: string;
  /** Provider-hosted page where the customer pays. */
  checkoutUrl: string;
  expiresAt: Date | null;
};

/** A webhook whose authenticity was verified. Only a hint: the service re-fetches the state. */
export type VerifiedWebhook = {
  eventId: string;
  type: string;
  providerPaymentId: string | null;
  reference: string | null;
};

export type PaymentErrorCode =
  | "NOT_CONFIGURED"
  | "INVALID_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "NOT_FOUND"
  | "DECLINED"
  | "BAD_REQUEST"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE";

export class PaymentProviderError extends Error {
  constructor(
    public readonly code: PaymentErrorCode,
    message: string,
    public readonly provider: string,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }

  /** The provider may have acted on the request even though we got no clear answer. */
  get ambiguous(): boolean {
    return this.code === "TIMEOUT" || this.code === "UNAVAILABLE";
  }
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  /** False for simulators: the UI labels them and they never move real money. */
  readonly live: boolean;
  /**
   * "redirect": an online gateway (create payment → hosted checkout → the
   * provider's API confirms). "manual": the customer pays outside the site and
   * submits a request that an administrator verifies and approves.
   */
  readonly flow: "redirect" | "manual";

  /** Methods this provider account can accept right now. */
  methods(): PaymentMethodInfo[];

  createPayment(request: CreatePaymentRequest): Promise<CreatedPayment>;

  /** Authoritative current state, straight from the provider. */
  getPayment(providerPaymentId: string): Promise<ProviderPaymentState>;

  /** Looks a payment up by our reference (recovers from lost create responses). */
  findPaymentByReference?(reference: string): Promise<ProviderPaymentState | null>;

  /** Verifies authenticity (signature) and shape; throws INVALID_SIGNATURE / INVALID_PAYLOAD. */
  verifyWebhook(rawBody: string, headers: Headers): VerifiedWebhook;

  /** Returns money to the customer, where supported (used by staff tooling in a later phase). */
  refundPayment?(providerPaymentId: string, amount: number): Promise<void>;
}
