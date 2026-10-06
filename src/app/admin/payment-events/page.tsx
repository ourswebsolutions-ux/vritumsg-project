import type { Metadata } from "next";
import Link from "next/link";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { one, pageHref, pageParam } from "@/components/admin/AdminParts";
import { AdminTable } from "@/components/admin/AdminTable";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { EmptyState } from "@/components/ui/States";
import { formatShortDateTime } from "@/lib/format";
import { requireAdminPage } from "@/server/admin/guard";
import { listPaymentEvents } from "@/server/admin/orders";

export const metadata: Metadata = { title: "Payment webhooks" };

export default async function AdminPaymentEventsPage({ searchParams }: PageProps<"/admin/payment-events">) {
  await requireAdminPage("/admin/payment-events");
  const sp = await searchParams;
  const q = one(sp.q, 100);
  const provider = ["cryptomus"].find((p) => p === one(sp.provider));
  const problems = one(sp.problems) === "1";
  const data = await listPaymentEvents({ q, provider, problems, page: pageParam(sp.page) });

  return (
    <Card>
      <PageHeader
        title="Payment webhooks"
        description="Verified provider notifications and what happened to each. Webhooks with a bad signature are rejected before this point and appear in System logs (webhook_rejected)."
      />
      <AdminFilters
        action="/admin/payment-events"
        active={Boolean(q || provider || problems)}
        fields={[
          { kind: "search", name: "q", placeholder: "Event ID / invoice UUID or order ID", value: q },
          { kind: "select", name: "provider", label: "Provider", value: provider, options: [{ value: "", label: "Any provider" }, { value: "cryptomus", label: "Cryptomus" }] },
          { kind: "select", name: "problems", label: "Show", value: problems ? "1" : "", options: [{ value: "", label: "All events" }, { value: "1", label: "Unprocessed / errors" }] },
        ]}
      />
      <AdminTable
        rows={data.items}
        rowKey={(e) => e.id}
        empty={<EmptyState compact icon="inbox" title="No webhooks received" />}
        columns={[
          { header: "Received", className: "whitespace-nowrap text-fg-muted", cell: (e) => formatShortDateTime(e.createdAt) },
          { header: "Provider", cell: (e) => e.provider },
          { header: "Event", desktopOnly: true, className: "font-mono text-xs break-all", cell: (e) => e.eventId },
          {
            header: "Payment",
            cell: (e) =>
              e.payment ? (
                <Link href={`/admin/payments/${e.payment.id}`} className="font-mono text-primary hover:underline">
                  {e.payment.reference}
                </Link>
              ) : (
                "—"
              ),
          },
          {
            header: "Result",
            cell: (e) => (
              <span className="text-xs">
                {e.processedAt ? <Badge tone={e.error ? "warning" : "success"}>{e.result ?? "processed"}</Badge> : <Badge tone="danger">{e.result ?? "unprocessed"}</Badge>}
                {e.error && <span className="mt-1 block text-fg-muted">{e.error}</span>}
              </span>
            ),
          },
        ]}
      />
      <Pagination page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={pageHref("/admin/payment-events", sp)} />
    </Card>
  );
}
