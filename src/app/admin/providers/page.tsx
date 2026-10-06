import type { Metadata } from "next";
import { ActionButton } from "@/components/admin/AdminForms";
import { KeyValues, ProviderStatusBadge, YesNo } from "@/components/admin/AdminParts";
import { AdminTable } from "@/components/admin/AdminTable";
import { Badge } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { formatDateTime, formatPrice } from "@/lib/format";
import { adminCatalogSyncAction } from "@/server/actions/admin";
import { requireAdminPage } from "@/server/admin/guard";
import { getProvidersOverview } from "@/server/admin/platform";

export const metadata: Metadata = { title: "Providers" };

/** Connection health and configuration. Secrets are only reported as set / not set. */
export default async function AdminProvidersPage({ searchParams }: PageProps<"/admin/providers">) {
  await requireAdminPage("/admin/providers");
  const fresh = (await searchParams).check === "1";
  const o = await getProvidersOverview({ fresh });
  const s = o.sms;

  return (
    <>
      <Card>
        <PageHeader
          title="SMS provider"
          description="Live status from a balance check (cached 30 s) plus the request log."
          actions={
            <ButtonLink href="/admin/providers?check=1" size="sm" variant="outline">
              Check now
            </ButtonLink>
          }
        />
        <KeyValues
          rows={[
            ["Provider", s.label],
            ["Enabled", <YesNo key="e" value={s.enabled} />],
            ["Status", <ProviderStatusBadge key="s" status={s.status} />],
            ["API host", <span key="h" className="font-mono text-xs">{s.apiHost}</span>],
            ["API key", s.apiKey],
            ["Our balance", s.balance !== null ? `${formatPrice(s.balance, s.balanceCurrency)}${s.balance === 0 ? " — top up the provider account to sell numbers" : ""}` : "—"],
            ["Failures (15 min)", String(s.recentFailures15m)],
            ["Last successful request", s.lastSuccess ? `${s.lastSuccess.action} · ${formatDateTime(s.lastSuccess.at)}` : "—"],
            [
              "Last error",
              s.lastError ? `${s.lastError.action} · ${s.lastError.errorCategory ?? "error"}${s.lastError.errorCode ? ` (${s.lastError.errorCode})` : ""} · ${formatDateTime(s.lastError.at)}` : "—",
            ],
          ]}
        />
      </Card>

      <Card>
        <PageHeader
          as="h2"
          title="Catalog sync"
          description="Countries, services and prices imported from the provider."
          actions={<ActionButton action={adminCatalogSyncAction} fields={{}} label="Sync now" confirm={{ title: "Sync the catalog now?", body: "Downloads the full price list from the provider (about a minute). It runs in the background.", cta: "Start sync" }} />}
        />
        <KeyValues
          rows={[
            ["Last successful sync", s.catalog.lastSuccessAt ? formatDateTime(s.catalog.lastSuccessAt) : "Never"],
            ["Last sync error", s.catalog.lastError ?? "—"],
            ["Countries / services", `${s.catalog.countries.toLocaleString("en-US")} / ${s.catalog.services.toLocaleString("en-US")}`],
            ["Offers in stock", s.catalog.offersInStock.toLocaleString("en-US")],
          ]}
        />
      </Card>

      <Card>
        <PageHeader as="h2" title="API health, last 24 hours" />
        <AdminTable
          rows={s.actions}
          rowKey={(a) => a.action}
          empty={<EmptyState compact icon="cpu" title="No provider requests in the last 24 hours" />}
          columns={[
            { header: "Action", className: "font-mono text-xs", cell: (a) => a.action },
            { header: "OK", className: "text-end tabular-nums", cell: (a) => a.ok },
            { header: "Failed", className: "text-end tabular-nums", cell: (a) => (a.failed ? <Badge tone="danger">{a.failed}</Badge> : "0") },
            { header: "Avg time", className: "text-end tabular-nums", cell: (a) => `${a.avgMs} ms` },
          ]}
        />
      </Card>

      <Card>
        <PageHeader as="h2" title="Payments and email" />
        <KeyValues
          rows={[
            ["Payment methods", `${o.payments.label}${o.payments.flow === "manual" ? " — manual requests are verified by administrators in Top-ups" : ""}`],
            ["New request alerts", o.payments.adminNotifyEmail ? `Emailed to ${o.payments.adminNotifyEmail}` : "Not set (ADMIN_NOTIFY_EMAIL)"],
            ["Email delivery", o.email.mode === "smtp" ? `SMTP · ${o.email.host}` : o.email.mode === "outbox" ? "Local outbox (development)" : "Not configured"],
            ["SMTP user", o.email.user ?? "—"],
            ["SMTP password", o.email.password],
          ]}
        />
      </Card>
    </>
  );
}
