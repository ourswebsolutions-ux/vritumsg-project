"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { cn } from "@/lib/cn";
import { formatPrice } from "@/lib/format";
import { whatsappHref } from "@/lib/whatsapp";
import { verifyTopUpAction } from "@/server/actions/payments";
import type { ManualPaymentDetails, PaymentListItem } from "@/types/account";
import { PaymentStatusBadge } from "./PaymentStatus";
import { useT } from "@/i18n/client";
import type { MessageKey } from "@/i18n/translate";
import { DateTime } from "@/components/ui/DateTime";
import { Money } from "@/components/currency/DisplayCurrency";

const POLL_MS = 4_000;
/** Stop automatic polling after this long; "Check now" still works. */
const POLL_FOR_MS = 15 * 60_000;

const OPEN = ["pending", "processing"];

const VIEW: Record<PaymentListItem["status"], { icon: IconName; tone: string; title: MessageKey; body: MessageKey }> = {
  pending: {
    icon: "history",
    tone: "bg-primary-tint text-primary",
    title: "psv.pending.title",
    body: "psv.pending.body",
  },
  processing: {
    icon: "refresh",
    tone: "bg-primary-tint text-primary",
    title: "psv.processing.title",
    body: "psv.processing.body",
  },
  paid: {
    icon: "checkCircle",
    tone: "bg-success-tint text-success",
    title: "psv.paid.title",
    body: "psv.paid.body",
  },
  failed: {
    icon: "alert",
    tone: "bg-danger-tint text-danger",
    title: "psv.failed.title",
    body: "psv.failed.body",
  },
  cancelled: {
    icon: "close",
    tone: "bg-surface-muted text-fg-muted",
    title: "psv.cancelled.title",
    body: "psv.cancelled.body",
  },
  expired: {
    icon: "history",
    tone: "bg-surface-muted text-fg-muted",
    title: "psv.expired.title",
    body: "psv.expired.body",
  },
  refunded: {
    icon: "refresh",
    tone: "bg-warning/15 text-[#a37c00] dark:text-warning",
    title: "psv.refunded.title",
    body: "psv.refunded.body",
  },
  rejected: {
    icon: "alert",
    tone: "bg-danger-tint text-danger",
    title: "psv.rejected.title",
    body: "psv.rejected.body",
  },
  underpaid: {
    icon: "alert",
    tone: "bg-warning/15 text-[#a37c00] dark:text-warning",
    title: "psv.underpaid.title",
    body: "psv.underpaid.body",
  },
};

/** Manual (admin-verified) requests: accurate wording, no gateway language. */
const MANUAL_VIEW: Partial<Record<PaymentListItem["status"], (typeof VIEW)["pending"]>> = {
  pending: {
    icon: "history",
    tone: "bg-primary-tint text-primary",
    title: "psvManual.pending.title",
    body: "psvManual.pending.body",
  },
  paid: {
    icon: "checkCircle",
    tone: "bg-success-tint text-success",
    title: "psvManual.paid.title",
    body: "psvManual.paid.body",
  },
};

/**
 * Result page for one top-up. The status shown always comes from the server,
 * which checks with the payment provider — arriving here from the provider's
 * redirect is not treated as proof of payment.
 */
export function PaymentStatusView({
  payment: initial,
  balance,
  help,
  email,
}: {
  payment: PaymentListItem;
  balance: number;
  /** Manual payment contact, for the WhatsApp help button. */
  help?: ManualPaymentDetails | null;
  email?: string;
}) {
  const router = useRouter();
  const t = useT();
  const [payment, setPayment] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const open = OPEN.includes(payment.status);
  const wasOpen = useRef(open);

  // Server re-renders (router.refresh) bring newer data.
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setPayment(initial);
  }

  useEffect(() => {
    if (!open) return;
    const started = Date.now();
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || Date.now() - started > POLL_FOR_MS) return;
      try {
        const res = await fetch(`/api/payments/${payment.id}`, {
          cache: "no-store",
        });
        if (res.ok && !stopped) setPayment(((await res.json()) as { payment: PaymentListItem }).payment);
      } catch {
        /* transient: next tick */
      }
    };
    // Manual reviews take minutes to hours: poll gently.
    const id = window.setInterval(tick, payment.manual ? 15_000 : POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [open, payment.id, payment.manual]);

  // Once the payment closes, re-render server data (balance in the header, lists).
  useEffect(() => {
    if (wasOpen.current && !open) router.refresh();
    wasOpen.current = open;
  }, [open, router]);

  function checkNow() {
    setNotice(null);
    startTransition(async () => {
      try {
        const r = await verifyTopUpAction(payment.id);
        if (r.ok) setPayment(r.payment);
        else setNotice(t.server(r.message));
      } catch {
        setNotice(t("order.unreachable"));
      }
    });
  }

  const v = (payment.manual && MANUAL_VIEW[payment.status]) || VIEW[payment.status];
  const wa = help ? whatsappHref(help, { email, reference: payment.reference }, t) : null;
  const money = (n: number) => formatPrice(n, payment.currency);

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center text-center" aria-live="polite">
        <span className={cn("flex size-16 items-center justify-center rounded-full", v.tone)}>
          <Icon name={v.icon} size={30} className={payment.status === "processing" ? "animate-spin [animation-duration:2.5s]" : undefined} />
        </span>
        <h1 className="mt-3 text-2xl font-semibold">{t(v.title)}</h1>
        {payment.status === "paid" && (
          <p className="mt-1 text-3xl font-bold text-success tabular-nums">
            <bdi>+{money(payment.amount)}</bdi>
          </p>
        )}
        <p className="mt-2 max-w-md text-[15px] text-fg-muted">{t(v.body)}</p>
        {payment.status === "rejected" && payment.rejectionReason && (
          <p className="mt-3 max-w-md rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
            {t("pay.reason")} <bdi>{payment.rejectionReason}</bdi>
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 rounded-xl bg-surface-muted p-4 text-[15px]">
        <dt className="text-fg-muted">{t("common.status")}</dt>
        <dd className="flex justify-end">
          <PaymentStatusBadge status={payment.status} manual={payment.manual} />
        </dd>
        <dt className="text-fg-muted">{t("psv.reference")}</dt>
        <dd className="flex items-center justify-end gap-1 font-mono">
          <bdi>{payment.reference}</bdi>
          <CopyButton value={payment.reference} label={t("psv.copyReference")} className="size-6" />
        </dd>
        {payment.transactionId && (
          <>
            <dt className="text-fg-muted">{t("psv.transactionId")}</dt>
            <dd className="text-end font-mono break-all">
              <bdi>{payment.transactionId}</bdi>
            </dd>
          </>
        )}
        <dt className="text-fg-muted">{payment.manual ? t("topup.paidWith") : t("pay.method")}</dt>
        <dd className="text-end">
          {payment.methodLabel}
          {payment.test && (
            <Badge tone="neutral" className="ms-1.5">
              {t("pay.test")}
            </Badge>
          )}
        </dd>
        <dt className="text-fg-muted">{t("common.amount")}</dt>
        <dd className="text-end tabular-nums">
          <Money amount={payment.amount} currency={payment.currency} variant="stack" className="items-end" />
        </dd>
        <dt className="text-fg-muted">{t("pay.fee")}</dt>
        <dd className="text-end tabular-nums">{payment.fee ? money(payment.fee) : t("topup.free")}</dd>
        <dt className="text-fg-muted">{t("common.total")}</dt>
        <dd className="text-end font-semibold tabular-nums">
          <Money amount={payment.total} currency={payment.currency} variant="stack" className="items-end" />
        </dd>
        <dt className="text-fg-muted">{t("pay.submitted")}</dt>
        <dd className="text-end">
          <DateTime iso={payment.createdAt} />
        </dd>
        {(payment.reviewedAt ?? payment.paidAt) && (
          <>
            <dt className="text-fg-muted">
              {payment.status === "rejected" ? t("pay.status.rejected") : payment.manual ? t("pay.status.approved") : t("pay.status.paid")}
            </dt>
            <dd className="text-end">
              <DateTime iso={(payment.reviewedAt ?? payment.paidAt)!} />
            </dd>
          </>
        )}
        <dt className="border-t border-line pt-2.5 text-fg-muted">{t("purchase.yourBalance")}</dt>
        <dd className="border-t border-line pt-2.5 text-end font-semibold tabular-nums"><Money amount={balance} currency={payment.currency} variant="stack" className="items-end" /></dd>
      </dl>

      {notice && <Alert tone="warning">{notice}</Alert>}

      <div className="flex flex-wrap justify-center gap-2">
        {payment.status === "paid" ? (
          <>
            <ButtonLink href="/price">{t("market.buyNumber")}</ButtonLink>
            <ButtonLink href="/profile/top-up" variant="outline">
              {t("psv.addMore")}
            </ButtonLink>
          </>
        ) : payment.manual && open ? (
          <>
            {wa && (
              <ButtonLink href={wa} target="_blank" rel="noopener noreferrer" className="!bg-[#25d366] hover:!bg-[#1ebe5a]">
                <Icon name="message" size={16} /> {t("wa.contact")}
              </ButtonLink>
            )}
            <Button variant="outline" onClick={checkNow} loading={pending} disabled={pending}>
              <Icon name="refresh" size={16} /> {t("psv.refresh")}
            </Button>
          </>
        ) : payment.manual ? (
          <>
            <ButtonLink href="/profile/top-up">{payment.status === "rejected" ? t("psv.newRequest") : t("psv.addMore")}</ButtonLink>
            {wa && payment.status === "rejected" && (
              <ButtonLink href={wa} target="_blank" rel="noopener noreferrer" variant="outline">
                <Icon name="message" size={16} /> {t("psv.contactSupport")}
              </ButtonLink>
            )}
          </>
        ) : open ? (
          <>
            {payment.checkoutUrl && (
              <ButtonLink href={payment.checkoutUrl}>
                {t("topup.continue")} <Icon name="arrowRight" size={16} />
              </ButtonLink>
            )}
            <Button variant="outline" onClick={checkNow} loading={pending} disabled={pending}>
              <Icon name="refresh" size={16} /> {t("psv.checkStatus")}
            </Button>
          </>
        ) : (
          <>
            <ButtonLink href="/profile/top-up">{payment.status === "refunded" ? t("nav.addFunds") : t("common.retry")}</ButtonLink>
            <Button variant="outline" onClick={checkNow} loading={pending} disabled={pending}>
              <Icon name="refresh" size={16} /> {t("psv.checkAgain")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
