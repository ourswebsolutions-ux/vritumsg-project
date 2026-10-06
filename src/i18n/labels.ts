import type { OrderStatus, PaymentStatus, TransactionListItem, TransactionType } from "@/types/account";
import type { DateRange } from "@/lib/date-range";
import type { MessageKey, Translator } from "./translate";

/** Status/type → dictionary keys, shared by server and client components (kept out of "use client" modules). */

type Tone = "soft" | "success" | "neutral" | "danger" | "warning";

export const ORDER_STATUS: Record<OrderStatus, { label: MessageKey; tone: Tone; description: MessageKey }> = {
  pending: { label: "order.status.pending", tone: "soft", description: "order.status.pendingHint" },
  active: { label: "order.status.active", tone: "soft", description: "order.status.activeHint" },
  sms_received: { label: "order.status.smsReceived", tone: "success", description: "order.status.smsReceivedHint" },
  completed: { label: "order.status.completed", tone: "success", description: "order.status.completedHint" },
  cancelled: { label: "order.status.cancelled", tone: "neutral", description: "order.status.cancelledHint" },
  refunded: { label: "order.status.refunded", tone: "warning", description: "order.status.refundedHint" },
  failed: { label: "order.status.failed", tone: "danger", description: "order.status.failedHint" },
  expired: { label: "order.status.expired", tone: "danger", description: "order.status.expiredHint" },
};

export const PAYMENT_STATUS: Record<PaymentStatus, { label: MessageKey; tone: Tone }> = {
  pending: { label: "pay.status.pending", tone: "soft" },
  processing: { label: "pay.status.processing", tone: "soft" },
  paid: { label: "pay.status.paid", tone: "success" },
  failed: { label: "pay.status.failed", tone: "danger" },
  cancelled: { label: "pay.status.cancelled", tone: "neutral" },
  expired: { label: "pay.status.expired", tone: "neutral" },
  refunded: { label: "pay.status.refunded", tone: "warning" },
  rejected: { label: "pay.status.rejected", tone: "danger" },
  underpaid: { label: "pay.status.underpaid", tone: "warning" },
};

/** Manual (admin-verified) top-ups read differently. */
const MANUAL_PAYMENT: Partial<Record<PaymentStatus, MessageKey>> = { pending: "pay.status.awaitingVerification", paid: "pay.status.approved" };

export const paymentStatusKey = (status: PaymentStatus, manual = false): MessageKey => (manual && MANUAL_PAYMENT[status]) || PAYMENT_STATUS[status].label;

export const TRANSACTION_TYPE: Record<TransactionType, MessageKey> = {
  deposit: "tx.deposit",
  purchase: "tx.purchase",
  refund: "tx.refund",
  adjustment: "tx.adjustment",
};

export const TRANSACTION_STATUS: Record<TransactionListItem["status"], MessageKey> = {
  completed: "tx.completed",
  pending: "tx.pending",
  failed: "tx.failed",
};

/** A date range's label in the visitor's language (dates stay numeric, YYYY-MM-DD). */
export function dateRangeLabel(range: DateRange, t: Translator): string {
  switch (range.preset) {
    case "all":
      return t("range.all");
    case "custom":
      return range.fromStr && range.toStr
        ? t("range.between", { from: range.fromStr, to: range.toStr })
        : range.fromStr
          ? t("range.since", { date: range.fromStr })
          : t("range.until", { date: range.toStr ?? "" });
    default:
      return t(`range.${range.preset}`);
  }
}
