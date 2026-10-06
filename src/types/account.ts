/** Account DTOs shared between server and client. No internal ids beyond what the UI needs. */

export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };

export type OrderStatus =
  | "pending"
  | "active"
  | "sms_received"
  | "completed"
  | "cancelled"
  | "refunded"
  | "failed"
  | "expired";

/** Statuses where the number is live and may still receive SMS. */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = ["pending", "active", "sms_received"];

export type OrderListItem = {
  id: string;
  service: { slug: string; name: string; color: string; logo: string | null };
  country: { id: string; iso2: string | null; name: string };
  phoneNumber: string | null;
  status: OrderStatus;
  price: number;
  currency: string;
  /** Latest code/SMS received, if any. */
  code: string | null;
  smsText: string | null;
  smsCount: number;
  /** Messages received so far, oldest first (up to 20). */
  messages: OrderSms[];
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  cancelableAt: string | null;
  canCancel: boolean;
  canFinish: boolean;
  canRequestAnother: boolean;
};

export type OrderSms = {
  id: string;
  code: string | null;
  text: string;
  sender: string | null;
  receivedAt: string;
};

/** A ledger entry tied to one order (its charge and any refund). */
export type OrderLedgerEntry = {
  id: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
};

export type OrderDetail = { order: OrderListItem; ledger: OrderLedgerEntry[] };

/** One received SMS with the activation it belongs to (the caller's own). */
export type SmsHistoryItem = {
  id: string;
  orderId: string;
  service: { name: string; color: string; logo: string | null };
  country: { iso2: string | null; name: string };
  phoneNumber: string | null;
  sender: string | null;
  code: string | null;
  text: string;
  receivedAt: string;
};

export type OrderFilter = {
  status?: "active" | "completed" | "cancelled" | "all";
  q?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
};

export type TransactionType =
  | "deposit"
  | "purchase"
  | "refund"
  | "adjustment";

export type TransactionStatus = "pending" | "completed" | "failed";

export type TransactionListItem = {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: number;
  balanceAfter: number;
  currency: string;
  description: string | null;
  /** The order or top-up payment this entry belongs to (the caller's own). */
  orderId: string | null;
  paymentId: string | null;
  createdAt: string;
};

export type AccountProfile = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  balance: number;
  currency: string;
  apiKeyHint: string | null;
  /** Account standing (only active accounts can sign in). */
  status: "active" | "suspended";
  emailVerified: boolean;
};

export type OrderStats = {
  total: number;
  completed: number;
  cancelled: number;
  active: number;
  smsReceived: number;
  /** Net spend: purchases minus refunds. */
  spent: number;
  deposits: number;
  /** Current balance (not limited to the range). */
  balance: number;
  payments: { paid: number; paidAmount: number; pending: number; unpaid: number };
  currency: string;
  /** Orders per day (UTC) for the chart, oldest first; at most 62 days. */
  byDay: { date: string; total: number; completed: number }[];
  byService: { name: string; color: string; logo: string | null; total: number; completed: number; spent: number }[];
};

export type PaymentStatus = "pending" | "processing" | "paid" | "failed" | "cancelled" | "expired" | "refunded" | "rejected" | "underpaid";

/** A wallet top-up as shown to its owner. Amounts are integer minor units. */
export type PaymentListItem = {
  id: string;
  /** Public reference, e.g. "TP-7K2M9QXA4D". */
  reference: string;
  /** Credited to the wallet. */
  amount: number;
  fee: number;
  /** Charged by the payment provider (amount + fee). */
  total: number;
  currency: string;
  method: string;
  methodLabel: string;
  /** "manual", "cryptomus", … */
  provider: string;
  status: PaymentStatus;
  createdAt: string;
  paidAt: string | null;
  failedAt: string | null;
  expiresAt: string | null;
  /** Provider page to complete the payment, while it can still be paid. */
  checkoutUrl: string | null;
  /** Made with a simulator (no real money). */
  test: boolean;
  /** Manual (Easypaisa / JazzCash) request verified by an administrator. */
  manual: boolean;
  /** Manual: the Easypaisa / JazzCash transaction ID the customer submitted. */
  transactionId: string | null;
  /** Manual: when it was approved or rejected, and why it was rejected. */
  reviewedAt: string | null;
  rejectionReason: string | null;
};

/** Where customers send manual payments (public details shown on Add funds). */
export type ManualPaymentDetails = {
  accountName: string;
  accountNumber: string;
  whatsapp: string | null;
  /** International digits for a wa.me link, when the number is valid. */
  whatsappDigits: string | null;
  note: string;
};

export type TopUpMethod = { id: string; label: string; description?: string; kind: string };

/** One payment provider offered on the add-funds page (limits/fees are its own). */
export type TopUpProviderOption = {
  id: string;
  flow: "redirect" | "manual";
  /** Admin-set display name (Cryptomus), or null for the built-in wording. */
  label: string | null;
  description: string | null;
  test: boolean;
  currency: string;
  min: number;
  max: number;
  feePercent: string;
  feeFixed: number;
  presets: number[];
  methods: TopUpMethod[];
};

/** What the add-funds form may offer; all limits are enforced again on the server. */
export type TopUpOptions = {
  available: boolean;
  /** Every provider a customer can use now, in admin order. */
  providers: TopUpProviderOption[];
  /** "manual": send money yourself, then submit a request an admin approves. */
  flow: "redirect" | "manual";
  manual: ManualPaymentDetails | null;
  /** The configured provider is a simulator. */
  test: boolean;
  currency: string;
  min: number;
  max: number;
  /** Fee percent as configured, e.g. "2.5". */
  feePercent: string;
  feeFixed: number;
  presets: number[];
  methods: TopUpMethod[];
};

/** Who is looking at the marketplace — drives purchase prompts and balance display. */
export type Viewer = { signedIn: false } | { signedIn: true; balance: number; currency: string };
