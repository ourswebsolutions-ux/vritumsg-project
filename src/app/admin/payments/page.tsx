import type { Metadata } from "next";
import Link from "next/link";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { one, pageHref, pageParam } from "@/components/admin/AdminParts";
import { AdminTable } from "@/components/admin/AdminTable";
import { PaymentStatusBadge } from "@/components/payments/PaymentStatus";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/States";
import { resolveDateRange } from "@/lib/date-range";
import { formatPrice, formatShortDateTime } from "@/lib/format";
import { requireAdminPage } from "@/server/admin/guard";
import { listAdminPayments } from "@/server/admin/orders";
import { ProviderBadge } from "@/components/admin/ProviderBadge";

export const metadata: Metadata = { title: "Payments" };

const STATUSES = ["pending", "processing", "paid", "underpaid", "failed", "cancelled", "expired", "refunded", "rejected"];
const PROVIDERS = [
  { value: "manual", label: "Manual (Easypaisa / JazzCash)" },
  { value: "cryptomus", label: "Cryptomus" },
];
const METHODS = [
  { value: "easypaisa", label: "Easypaisa" },
  { value: "jazzcash", label: "JazzCash" },
  { value: "crypto", label: "Crypto" },
];

export default async function AdminPaymentsPage({ searchParams }: PageProps<"/admin/payments">) {
  await requireAdminPage("/admin/payments");
  const sp = await searchParams;
  const q = one(sp.q);
  const status = STATUSES.find((s) => s === one(sp.status));
  const review = one(sp.review) === "1";
  const method = METHODS.find((m) => m.value === one(sp.method))?.value;
  const provider = PROVIDERS.find((p) => p.value === one(sp.provider))?.value;
  const userId = /^[0-9a-f-]{36}$/.test(one(sp.userId) ?? "") ? one(sp.userId) : undefined;
  const range = resolveDateRange({ from: one(sp.from, 10), to: one(sp.to, 10) });
  const data = await listAdminPayments({ q, status, review, method, provider, userId, from: range.from, to: range.to, page: pageParam(sp.page) });

  return (
    <Card>
      <PageHeader title="Payments" description={`${data.total.toLocaleString("en-US")} matching top-ups`} />
      <AdminFilters
        action="/admin/payments"
        active={Boolean(q || status || review || method || provider || userId || range.preset !== "all")}
        fields={[
          ...(userId ? [{ kind: "hidden" as const, name: "userId", value: userId }] : []),
          { kind: "search", name: "q", placeholder: "Order ID, payment ID, Cryptomus UUID or user email", value: q },
          { kind: "select", name: "status", label: "Status", value: status, options: [{ value: "", label: "Any status" }, ...STATUSES.map((s) => ({ value: s, label: s }))] },
          { kind: "select", name: "provider", label: "Provider", value: provider, options: [{ value: "", label: "Any provider" }, ...PROVIDERS] },
          { kind: "select", name: "method", label: "Method", value: method, options: [{ value: "", label: "Any method" }, ...METHODS] },
          { kind: "select", name: "review", label: "Review", value: review ? "1" : "", options: [{ value: "", label: "All" }, { value: "1", label: "Needs review" }] },
          { kind: "date", name: "from", label: "From", value: range.fromStr },
          { kind: "date", name: "to", label: "To", value: range.toStr },
        ]}
      />
      {range.error && <Alert tone="warning" className="mb-3">{range.error}</Alert>}
      <AdminTable
        rows={data.items}
        rowKey={(p) => p.id}
        empty={<EmptyState compact icon="wallet" title="No payments match" />}
        columns={[
          {
            header: "Payment",
            cell: (p) => (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Link href={`/admin/payments/${p.id}`} className="font-mono text-primary hover:underline">{p.reference}</Link>
                {p.needsReview && <Badge tone="danger">Review</Badge>}
              </span>
            ),
          },
          { header: "User", cell: (p) => <Link href={`/admin/users/${p.user.id}`} className="block max-w-48 truncate hover:text-primary">{p.user.email}</Link> },
          { header: "Provider", desktopOnly: true, cell: (p) => <ProviderBadge provider={p.provider} method={p.method} /> },
          { header: "Status", cell: (p) => <PaymentStatusBadge status={p.status} manual={p.provider === "manual"} /> },
          { header: "Amount", className: "text-end tabular-nums", cell: (p) => formatPrice(p.amount, p.currency) },
          { header: "Fee", className: "text-end tabular-nums text-fg-muted", desktopOnly: true, cell: (p) => formatPrice(p.fee, p.currency) },
          { header: "Date", className: "whitespace-nowrap text-fg-muted", cell: (p) => formatShortDateTime(p.createdAt) },
        ]}
      />
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={pageHref("/admin/payments", sp)} />
    </Card>
  );
}
