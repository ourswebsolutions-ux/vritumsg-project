import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton, ReviewForm } from "@/components/admin/AdminForms";
import { KeyValues } from "@/components/admin/AdminParts";
import { AdminTable } from "@/components/admin/AdminTable";
import { PaymentStatusBadge } from "@/components/payments/PaymentStatus";
import { TRANSACTION_LABEL } from "@/components/profile/TransactionsTable";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { formatDateTime, formatPrice, formatShortDateTime } from "@/lib/format";
import { adminRecheckPaymentAction, adminResendWebhookAction, adminResolveReviewAction } from "@/server/actions/admin";
import { ProviderBadge } from "@/components/admin/ProviderBadge";
import { requireAdminPage } from "@/server/admin/guard";
import { getAdminPayment } from "@/server/admin/orders";

export const metadata: Metadata = { title: "Payment" };

const PROVIDER_FIELD: Record<string, string> = {
  providerStatus: "Provider status",
  isFinal: "Final",
  paymentAmount: "Amount paid (coin)",
  payerAmount: "Expected amount (coin)",
  payerCurrency: "Coin",
  merchantAmount: "Merchant amount",
  network: "Network",
  txid: "TXID",
  commission: "Cryptomus commission",
  providerUpdatedAt: "Provider updated at",
  checkedAt: "Last checked",
};

export default async function AdminPaymentPage({ params }: PageProps<"/admin/payments/[id]">) {
  const { id } = await params;
  await requireAdminPage(`/admin/payments/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await getAdminPayment(id);
  if (!data) notFound();
  const p = data.payment;
  const money = (v: number) => formatPrice(v, p.currency);
  const crypto = p.provider === "cryptomus";

  return (
    <>
      <Card>
        <Breadcrumbs items={[{ label: "Payments", href: "/admin/payments" }, { label: p.reference }]} className="mb-3" />
        <PageHeader title={`Top-up ${p.reference}`} actions={<PaymentStatusBadge status={p.status} manual={p.provider === "manual"} />} />
        {p.needsReview && (
          <Alert tone="error" title="Needs review" className="mb-4">
            The provider&apos;s answer didn&apos;t match this payment ({p.failureReason ?? "unknown reason"}). Nothing was credited automatically.
            Investigate at the provider; correct the balance with a wallet adjustment on the user&apos;s page if needed, then close the review.
          </Alert>
        )}
        <KeyValues
          rows={[
            ["Payment ID", <span key="id" className="font-mono text-xs">{p.id}</span>],
            ["User", <Link key="u" href={`/admin/users/${p.user.id}`} className="text-primary hover:underline">{p.user.email}</Link>],
            ["Provider · method", <ProviderBadge key="pv" provider={p.provider} method={p.method} />],
            ["Order ID", <span key="o" className="font-mono text-xs">{p.reference}</span>],
            [crypto ? "Cryptomus invoice UUID" : "Provider reference", <span key="r" className="font-mono text-xs break-all">{p.providerPaymentId ?? "—"}</span>],
            ["Amount credited", money(p.amount)],
            ["Fee", money(p.fee)],
            ["Total charged", money(p.total)],
            ["Currency", p.currency],
            ["Created", formatDateTime(p.createdAt)],
            ["Paid", p.paidAt ? formatDateTime(p.paidAt) : "—"],
            ["Expires", data.expiresAt ? formatDateTime(data.expiresAt) : "—"],
            ["Failure / note", p.failureReason ?? "—"],
            ...(data.createError ? ([["Invoice creation error", data.createError]] as [string, string][]) : []),
            ...(data.review ? ([["Review closed", `${data.review.by} · ${formatDateTime(data.review.at)} — ${data.review.note}`]] as [string, string][]) : []),
          ]}
        />
        <div className="mt-5 flex flex-wrap items-start gap-3 border-t border-line pt-4">
          <ActionButton action={adminRecheckPaymentAction} fields={{ paymentId: p.id }} label="Re-check with provider" />
          {crypto && p.providerPaymentId && ["paid", "underpaid"].includes(p.status) && (
            <ActionButton action={adminResendWebhookAction} fields={{ paymentId: p.id }} label="Request webhook resend" />
          )}
          <p className="max-w-md text-xs text-fg-muted">
            Reads the provider&apos;s current state. The wallet is credited only if the provider confirms payment with a matching amount and
            currency — never from this page directly. A resent webhook is verified and de-duplicated, so it can&apos;t credit twice.
          </p>
        </div>
        {p.needsReview && (
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="mb-2 font-semibold">Close review</h3>
            <ReviewForm action={adminResolveReviewAction} paymentId={p.id} />
          </div>
        )}
      </Card>

      {data.providerDetails.length > 0 && (
        <Card>
          <PageHeader as="h2" title={crypto ? "Cryptomus details" : "Provider details"} description="As last reported by the provider when the payment was checked." />
          <KeyValues rows={data.providerDetails.map(([k, v]) => [PROVIDER_FIELD[k] ?? k, <span key={k} className="font-mono text-xs break-all">{v}</span>])} />
        </Card>
      )}

      <Card>
        <PageHeader as="h2" title="Ledger" />
        <AdminTable
          rows={data.ledger}
          rowKey={(t) => t.id}
          empty={<EmptyState compact icon="wallet" title="Not credited" description="No ledger entry exists for this payment." />}
          columns={[
            { header: "Type", cell: (t) => TRANSACTION_LABEL[t.type] },
            { header: "Amount", className: "text-end tabular-nums", cell: (t) => `+${money(t.amount)}` },
            { header: "Date", className: "whitespace-nowrap text-fg-muted", cell: (t) => formatShortDateTime(t.createdAt) },
          ]}
        />
      </Card>

      <Card>
        <PageHeader as="h2" title="Webhook events" />
        <AdminTable
          rows={data.events}
          rowKey={(e) => e.id}
          empty={<EmptyState compact icon="inbox" title="No webhooks received" />}
          columns={[
            { header: "Event", className: "font-mono text-xs", cell: (e) => e.eventId },
            { header: "Type", cell: (e) => e.type },
            { header: "Processed", cell: (e) => (e.processedAt ? <Badge tone="success">Yes</Badge> : <Badge tone="warning">No</Badge>) },
            { header: "Result", cell: (e) => <span className="text-xs">{e.result ?? "—"}{e.error ? <span className="block text-danger">{e.error}</span> : null}</span> },
            { header: "Received", className: "whitespace-nowrap text-fg-muted", cell: (e) => formatShortDateTime(e.createdAt) },
          ]}
        />
      </Card>
    </>
  );
}
