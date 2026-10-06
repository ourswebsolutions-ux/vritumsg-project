import "server-only";
import { toDecimalString, toMinor } from "@/lib/money";
import { db, type Prisma } from "@/server/db";
import { env } from "@/server/env";
import { listPaymentProviders } from "@/server/payments/registry";
import { getProvider } from "@/server/providers/registry";
import { getCatalogStatus, syncCatalog } from "@/server/services/catalog.service";
import { customerPrice } from "@/server/services/currency";
import { setPricingRules, type PricingRules } from "@/server/services/pricing-rules";
import { repriceCustomMargins } from "./margins";
import { checkProviderHealth, invalidateProviderBalance } from "@/server/services/provider-health.service";
import { maskAddress } from "@/server/services/security-log";
import { getSetting, saveSetting, whatsappDigits, type CurrencyMarkupSetting, type MaintenanceSetting, type ManualPaymentSetting } from "@/server/services/settings.service";
import { getDisplayRates } from "@/server/services/exchange-rates";
import type { AdminPage } from "@/types/admin";
import { audit } from "./audit";
import type { AdminActor } from "./guard";
import type { AdminResult } from "./users";

/* ------------------------------------------------------------- dashboard -- */

const DAY = 86_400_000;

type Range = { from?: Date; to?: Date };
const within = (r: Range) => (r.from || r.to ? { gte: r.from, lte: r.to } : undefined);

/** Net number revenue (purchases − refunds) and gross margin for a period, from the ledger and orders. */
async function revenue(r: Range) {
  const created = within(r);
  const [ledger, margin] = await Promise.all([
    db().transaction.groupBy({ by: ["type"], where: { status: "COMPLETED", type: { in: ["PURCHASE", "REFUND"] }, ...(created ? { createdAt: created } : {}) }, _sum: { amount: true } }),
    db().order.aggregate({ where: { status: "COMPLETED", ...(created ? { createdAt: created } : {}) }, _sum: { price: true, providerCost: true } }),
  ]);
  const sum = (t: string) => {
    const v = ledger.find((g) => g.type === t)?._sum.amount;
    return v ? toMinor(v) : 0;
  };
  const sales = -sum("PURCHASE") - sum("REFUND");
  const price = margin._sum.price ? toMinor(margin._sum.price) : 0;
  const cost = margin._sum.providerCost ? toMinor(margin._sum.providerCost) : 0;
  return { sales, margin: price - cost };
}

/**
 * Admin dashboard. Stock figures (users, balances, pending queues) are
 * current; flow figures (new users, orders, deposits, revenue) follow the
 * selected date range. Everything is aggregated in the database.
 */
export async function getDashboard(range: Range = {}) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since30 = new Date(now.getTime() - 30 * DAY);
  const created = within(range);
  const inRange = created ? { createdAt: created } : {};
  const chartTo = range.to ?? now;
  const toDay = Date.UTC(chartTo.getUTCFullYear(), chartTo.getUTCMonth(), chartTo.getUTCDate());
  const fromDay = range.from ? Math.min(toDay, Math.max(range.from.getTime(), toDay - 61 * DAY)) : toDay - 13 * DAY;

  const [users, byStatus, newUsers, active30, orders, ledger, balances, topups, perDay, recentAudit, health, revRange, revToday, revMonth, recent] = await Promise.all([
    db().user.count({ where: { deletedAt: null } }),
    db().user.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
    db().user.count({ where: { deletedAt: null, createdAt: created ?? { gte: today } } }),
    db().session.groupBy({ by: ["userId"], where: { lastUsedAt: { gte: since30 } } }).then((g) => g.length),
    db().order.groupBy({ by: ["status"], where: inRange, _count: { _all: true } }),
    db().transaction.groupBy({ by: ["type"], where: { status: "COMPLETED", ...inRange }, _sum: { amount: true } }),
    db().wallet.aggregate({ _sum: { balance: true } }),
    db().payment.groupBy({ by: ["status"], where: { provider: "manual", ...inRange }, _count: { _all: true }, _sum: { amount: true } }),
    db().$queryRaw<{ d: string; total: bigint | number; completed: unknown }[]>`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS d, COUNT(*) AS total, SUM(status = 'COMPLETED') AS completed
      FROM orders WHERE created_at >= ${new Date(fromDay)} AND created_at < ${new Date(toDay + DAY)} GROUP BY d`,
    db().auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    checkProviderHealth().catch(() => null),
    revenue(range),
    revenue({ from: today }),
    revenue({ from: monthStart }),
    Promise.all([
      db().transaction.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 6, include: { user: { select: { email: true } } } }),
      db().order.findMany({ orderBy: { createdAt: "desc" }, take: 6, include: { user: { select: { email: true } }, service: { select: { name: true } }, country: { select: { name: true } } } }),
      db().payment.findMany({ where: { provider: "manual" }, orderBy: { createdAt: "desc" }, take: 6, include: { user: { select: { email: true } } } }),
      db().user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 6, select: { id: true, name: true, email: true, createdAt: true } }),
    ]),
  ]);
  // Pending top-ups are a queue: always all-time.
  const pendingTopUps = await db().payment.count({ where: { provider: "manual", status: "PENDING" } });

  const count = (s: string[]) => orders.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
  const sum = (t: string) => {
    const v = ledger.find((g) => g.type === t)?._sum.amount;
    return v ? toMinor(v) : 0;
  };
  const topup = (s: string) => topups.find((g) => g.status === s);
  const days = new Map(perDay.map((r) => [r.d, { total: Number(r.total), completed: Number(String(r.completed ?? 0)) }]));
  const [recentTx, recentOrders, recentTopUps, recentUsers] = recent;
  return {
    currency: env().PLATFORM_CURRENCY,
    users: {
      total: users,
      active: byStatus.find((g) => g.status === "ACTIVE")?._count._all ?? 0,
      suspended: byStatus.find((g) => g.status === "SUSPENDED")?._count._all ?? 0,
      newInRange: newUsers,
      active30,
    },
    orders: {
      total: count(["PENDING", "ACTIVE", "SMS_RECEIVED", "COMPLETED", "CANCELLED", "REFUNDED", "FAILED", "EXPIRED"]),
      successful: count(["COMPLETED"]),
      failed: count(["FAILED"]),
      pending: count(["PENDING", "ACTIVE", "SMS_RECEIVED"]),
      cancelled: count(["CANCELLED", "REFUNDED", "EXPIRED"]),
    },
    money: {
      deposits: sum("DEPOSIT"),
      purchases: -sum("PURCHASE"),
      refunds: sum("REFUND"),
      adjustments: sum("ADJUSTMENT"),
      walletBalances: balances._sum.balance ? toMinor(balances._sum.balance) : 0,
    },
    revenue: { range: revRange, today: revToday, month: revMonth },
    topups: {
      pending: pendingTopUps,
      approved: topup("PAID")?._count._all ?? 0,
      approvedAmount: topup("PAID")?._sum.amount ? toMinor(topup("PAID")!._sum.amount!) : 0,
      rejected: topup("REJECTED")?._count._all ?? 0,
    },
    byDay: Array.from({ length: Math.round((toDay - fromDay) / DAY) + 1 }, (_, i) => {
      const date = new Date(fromDay + i * DAY).toISOString().slice(0, 10);
      return { date, ...(days.get(date) ?? { total: 0, completed: 0 }) };
    }),
    recentAudit: recentAudit.map((a) => ({
      id: String(a.id),
      actorEmail: a.actorEmail,
      action: a.action,
      description: a.description,
      targetType: a.targetType,
      targetId: a.targetId,
      success: a.success,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    })),
    recentTransactions: recentTx.map((t) => ({
      id: t.id,
      userId: t.userId,
      email: t.user.email,
      type: t.type.toLowerCase() as "deposit" | "purchase" | "refund" | "adjustment",
      amount: toMinor(t.amount),
      currency: t.currency,
      createdAt: t.createdAt.toISOString(),
    })),
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      email: o.user.email,
      label: `${o.service.name} · ${o.country.name}`,
      status: o.status.toLowerCase(),
      price: toMinor(o.price),
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    })),
    recentTopUps: recentTopUps.map((p) => ({
      id: p.id,
      reference: p.reference,
      email: p.user.email,
      amount: toMinor(p.amount),
      currency: p.currency,
      status: p.status.toLowerCase(),
      createdAt: p.createdAt.toISOString(),
    })),
    recentUsers: recentUsers.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })),
    provider: health ? { status: providerStatus(health), balance: health.balance } : null,
  };
}

/* ------------------------------------------------------------- providers -- */

export type ProviderStatus = "online" | "unavailable" | "auth_failed" | "timeout" | "rate_limited" | "not_configured" | "no_balance";

export function providerStatus(h: { configured: boolean; reachable: boolean; errorCategory: string | null; balance: number | null }): ProviderStatus {
  if (!h.configured || h.errorCategory === "NOT_CONFIGURED") return "not_configured";
  if (h.reachable) return h.balance === 0 ? "no_balance" : "online";
  switch (h.errorCategory) {
    case "UNAUTHORIZED":
      return "auth_failed";
    case "TIMEOUT":
      return "timeout";
    case "RATE_LIMITED":
      return "rate_limited";
    default:
      return "unavailable";
  }
}

/** Provider overview for admins. Credentials are only ever reported as "set" / "not set". */
export async function getProvidersOverview(opts: { fresh?: boolean } = {}) {
  if (opts.fresh) invalidateProviderBalance();
  const e = env();
  const since = new Date(Date.now() - DAY);
  const [health, lastOk, lastFail, byAction, catalog, counts] = await Promise.all([
    checkProviderHealth(),
    db().providerRequest.findFirst({ where: { success: true }, orderBy: { createdAt: "desc" }, select: { action: true, createdAt: true } }),
    db().providerRequest.findFirst({
      where: { success: false },
      orderBy: { createdAt: "desc" },
      select: { action: true, errorCategory: true, errorCode: true, httpStatus: true, createdAt: true },
    }),
    db().providerRequest.groupBy({ by: ["action", "success"], where: { createdAt: { gte: since } }, _count: { _all: true }, _avg: { durationMs: true } }),
    getCatalogStatus(),
    Promise.all([db().country.count(), db().service.count(), db().price.count({ where: { available: { gt: 0 } } })]),
  ]);
  const actions = [...new Set(byAction.map((a) => a.action))].sort().map((action) => {
    const ok = byAction.find((a) => a.action === action && a.success);
    const fail = byAction.find((a) => a.action === action && !a.success);
    return { action, ok: ok?._count._all ?? 0, failed: fail?._count._all ?? 0, avgMs: Math.round(ok?._avg.durationMs ?? fail?._avg.durationMs ?? 0) };
  });
  const paymentProviders = await listPaymentProviders();
  let apiHost = "—";
  try {
    apiHost = new URL(e.GRIZZLY_API_URL).host;
  } catch {
    /* invalid URL is reported by env validation */
  }
  return {
    sms: {
      id: getProvider().id,
      label: e.SMS_PROVIDER === "grizzly" ? "GrizzlySMS-compatible API" : "Not configured",
      enabled: e.SMS_PROVIDER !== "none",
      apiHost,
      apiKey: e.GRIZZLY_API_KEY ? "Set (hidden)" : "Not set",
      status: providerStatus(health),
      errorCategory: health.errorCategory,
      balance: health.balance,
      balanceCurrency: e.PROVIDER_CURRENCY,
      recentFailures15m: health.recentFailures,
      lastSuccess: lastOk ? { action: lastOk.action, at: lastOk.createdAt.toISOString() } : null,
      lastError: lastFail ? { ...lastFail, at: lastFail.createdAt.toISOString(), createdAt: undefined } : null,
      actions,
      catalog: { ...catalog, countries: counts[0], services: counts[1], offersInStock: counts[2] },
    },
    payments: {
      id: paymentProviders.map((p) => p.id).join(", ") || "none",
      label: paymentProviders.map((p) => p.label).join(" + ") || "Not configured",
      live: paymentProviders.every((p) => p.live),
      flow: paymentProviders.some((p) => p.flow === "manual") ? ("manual" as const) : (paymentProviders[0]?.flow ?? null),
      adminNotifyEmail: e.ADMIN_NOTIFY_EMAIL ? maskAddress(e.ADMIN_NOTIFY_EMAIL) : null,
    },
    email: {
      mode: e.SMTP_HOST ? "smtp" : e.MAIL_OUTBOX || e.NODE_ENV !== "production" ? "outbox" : "not_configured",
      host: e.SMTP_HOST ?? null,
      user: e.SMTP_USER ? maskAddress(e.SMTP_USER) : null,
      password: e.SMTP_PASSWORD ? "Set (hidden)" : "Not set",
    },
  };
}

export async function triggerCatalogSync(actor: AdminActor): Promise<AdminResult> {
  if (!getProvider().capabilities.has("catalog")) return { ok: false, message: "No SMS provider is configured." };
  // The full price list takes about a minute: run it in the background.
  void syncCatalog()
    .then((r) =>
      audit(actor, "provider.catalog_sync", null, Boolean(r), r ? { ...r } : { skipped: "already running" }, r ? `Catalog synced: ${r.countries} countries, ${r.services} services, ${r.prices} prices` : "Catalog sync skipped (already running)"),
    )
    .catch((error: unknown) => audit(actor, "provider.catalog_sync", null, false, { error: error instanceof Error ? error.name : "unknown" }, "Catalog sync failed"));
  return { ok: true, message: "Catalog sync started. It takes about a minute." };
}

/* --------------------------------------------------- countries & services -- */

type CatalogFilter = { q?: string; state?: "enabled" | "disabled" | "provider_off"; page?: number; pageSize?: number };

function catalogWhere(filter: CatalogFilter) {
  const q = filter.q?.trim();
  return {
    ...(q ? { OR: [{ name: { contains: q } }, { providerCode: q }] } : {}),
    ...(filter.state === "enabled" ? { isActive: true, providerActive: true } : {}),
    ...(filter.state === "disabled" ? { isActive: false } : {}),
    ...(filter.state === "provider_off" ? { providerActive: false } : {}),
  };
}

export async function listAdminCountries(filter: CatalogFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const where: Prisma.CountryWhereInput = catalogWhere(filter);
  const [rows, total] = await Promise.all([
    db().country.findMany({ where, orderBy: [{ displayOrder: "asc" }, { name: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db().country.count({ where }),
  ]);
  const stock = await db().price.groupBy({
    by: ["countryId"],
    where: { countryId: { in: rows.map((r) => r.id) }, available: { gt: 0 } },
    _count: { _all: true },
    _max: { syncedAt: true },
  });
  return {
    items: rows.map((c) => {
      const s = stock.find((x) => x.countryId === c.id);
      return {
        id: c.id,
        name: c.name,
        iso2: c.iso2,
        providerCode: c.providerCode,
        isActive: c.isActive,
        providerActive: c.providerActive,
        servicesInStock: s?._count._all ?? 0,
        syncedAt: s?._max.syncedAt?.toISOString() ?? null,
      };
    }),
    total,
    page,
    pageSize,
  };
}

export async function listAdminServices(filter: CatalogFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));
  const where: Prisma.ServiceWhereInput = catalogWhere(filter);
  const [rows, total] = await Promise.all([
    db().service.findMany({ where, orderBy: [{ isPopular: "desc" }, { displayOrder: "asc" }, { name: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db().service.count({ where }),
  ]);
  const stock = await db().price.groupBy({
    by: ["serviceId"],
    where: { serviceId: { in: rows.map((r) => r.id) }, available: { gt: 0 } },
    _count: { _all: true },
    _min: { price: true },
    _max: { syncedAt: true },
  });
  return {
    items: rows.map((s) => {
      const st = stock.find((x) => x.serviceId === s.id);
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        providerCode: s.providerCode,
        isPopular: s.isPopular,
        isActive: s.isActive,
        providerActive: s.providerActive,
        countriesInStock: st?._count._all ?? 0,
        minPrice: st?._min.price ? toMinor(st._min.price) : null,
        syncedAt: st?._max.syncedAt?.toISOString() ?? null,
      };
    }),
    total,
    page,
    pageSize,
  };
}

export async function getAdminService(serviceId: number, page = 1) {
  const service = await db().service.findUnique({ where: { id: serviceId } });
  if (!service) return null;
  const pageSize = 50;
  const [prices, total] = await Promise.all([
    db().price.findMany({
      where: { serviceId },
      include: { country: { select: { name: true, iso2: true, isActive: true, providerActive: true } } },
      orderBy: [{ available: "desc" }, { price: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db().price.count({ where: { serviceId } }),
  ]);
  return {
    service: { id: service.id, slug: service.slug, name: service.name, providerCode: service.providerCode, isActive: service.isActive, providerActive: service.providerActive, isPopular: service.isPopular },
    prices: {
      items: prices.map((p) => ({
        id: p.id,
        country: p.country,
        providerCost: toMinor(p.providerCost),
        providerCurrency: p.providerCurrency,
        price: toMinor(p.price),
        currency: p.currency,
        available: p.available,
        syncedAt: p.syncedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    },
  };
}

/** Local availability switch; the provider's own flag is never edited here. */
export async function setCatalogItemActive(actor: AdminActor, kind: "country" | "service", id: number, isActive: boolean): Promise<AdminResult> {
  const row = kind === "country" ? await db().country.findUnique({ where: { id } }) : await db().service.findUnique({ where: { id } });
  if (!row) return { ok: false, message: "Not found." };
  if (kind === "country") await db().country.update({ where: { id }, data: { isActive } });
  else await db().service.update({ where: { id }, data: { isActive } });
  await audit(actor, `${kind}.${isActive ? "enable" : "disable"}`, { type: kind, id: String(id) }, true, { name: row.name }, `${isActive ? "Enabled" : "Disabled"} ${kind} ${row.name}`);
  return { ok: true, message: `${row.name} ${isActive ? "enabled" : "disabled"}.` };
}

export async function setServicePopular(actor: AdminActor, id: number, isPopular: boolean): Promise<AdminResult> {
  const row = await db().service.findUnique({ where: { id } });
  if (!row) return { ok: false, message: "Not found." };
  await db().service.update({ where: { id }, data: { isPopular } });
  await audit(actor, `service.${isPopular ? "feature" : "unfeature"}`, { type: "service", id: String(id) }, true, { name: row.name }, `${isPopular ? "Featured" : "Unfeatured"} service ${row.name}`);
  return { ok: true, message: `${row.name} ${isPopular ? "featured" : "no longer featured"}.` };
}

/* --------------------------------------------------------------- pricing -- */

export async function getPricing() {
  const current = await getSetting("pricing");
  return {
    current,
    defaults: { markupPercent: String(env().PRICE_MARKUP_PERCENT), minMargin: String(env().PRICE_MIN_MARGIN) },
    currency: env().PLATFORM_CURRENCY,
    providerCurrency: env().PROVIDER_CURRENCY,
    fxRate: env().PROVIDER_FX_RATE,
  };
}

/** Recomputes every stored customer price from its stored provider cost (no provider calls). */
async function repriceAll(rules: PricingRules): Promise<number> {
  const costs = await db().price.groupBy({ by: ["providerCost"] });
  let updated = 0;
  for (let i = 0; i < costs.length; i += 200) {
    const chunk = costs.slice(i, i + 200);
    const results = await db().$transaction(
      chunk.map((c) =>
        db().price.updateMany({ where: { providerCost: c.providerCost }, data: { price: toDecimalString(customerPrice(toMinor(c.providerCost), rules)) } }),
      ),
    );
    updated += results.reduce((n, r) => n + r.count, 0);
  }
  // Service + country exceptions (Admin → Custom Margins) keep their own minimum margin.
  await repriceCustomMargins(rules);
  return updated;
}

export async function savePricing(actor: AdminActor, input: { markupPercent: string; minMargin: string }): Promise<AdminResult> {
  const markup = input.markupPercent.trim();
  const margin = input.minMargin.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(markup) || Number(markup) > 500) return { ok: false, message: "Markup must be between 0 and 500 (up to 2 decimals)." };
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(margin) || Number(margin) > 100) return { ok: false, message: "Minimum margin must be between 0 and 100 (up to 4 decimals)." };
  const before = await getSetting("pricing");
  const rules = await saveSetting("pricing", { markupPercent: markup, minMargin: margin });
  setPricingRules(rules);
  const repriced = await repriceAll(rules);
  await audit(
    actor,
    "pricing.update",
    { type: "setting", id: "pricing" },
    true,
    { before, after: rules, repriced },
    `Pricing changed: markup ${before.markupPercent}% → ${rules.markupPercent}%, minimum margin ${before.minMargin} → ${rules.minMargin} (${repriced} prices recalculated)`,
  );
  return { ok: true, message: `Pricing saved. ${repriced.toLocaleString("en-US")} prices recalculated.` };
}

/* ------------------------------------------------------------------ logs -- */

export type LogKind = "audit" | "security" | "provider" | "payments" | "wallet";
export type LogRow = {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  title: string;
  subject: string | null;
  detail: string | null;
  link: string | null;
};

type LogFilter = { q?: string; from?: Date; to?: Date; page?: number; pageSize?: number };

const between = (f: LogFilter) => (f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {});
const compact = (v: unknown) => (v && typeof v === "object" ? JSON.stringify(v).slice(0, 240) : null);

export async function listLogs(kind: LogKind, filter: LogFilter = {}): Promise<AdminPage<LogRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 30));
  const skip = (page - 1) * pageSize;
  const q = filter.q?.trim();

  if (kind === "audit") {
    const where: Prisma.AuditLogWhereInput = {
      ...between(filter),
      ...(q ? { OR: [{ action: { contains: q } }, { actorEmail: { contains: q.toLowerCase() } }, { targetId: { startsWith: q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      db().auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize }),
      db().auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        at: r.createdAt.toISOString(),
        level: r.success ? "info" : "warn",
        title: `${r.action}${r.success ? "" : " (failed)"}`,
        subject: r.actorEmail,
        detail: [r.targetType && r.targetId ? `${r.targetType} ${r.targetId}` : null, compact(r.metadata)].filter(Boolean).join(" · ") || null,
        link: r.targetType === "user" ? `/admin/users/${r.targetId}` : r.targetType === "order" ? `/admin/orders/${r.targetId}` : r.targetType === "payment" ? `/admin/payments/${r.targetId}` : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  if (kind === "security") {
    const where: Prisma.SystemLogWhereInput = { source: "auth", ...between(filter), ...(q ? { OR: [{ message: { contains: q } }, { userId: q }] } : {}) };
    const [rows, total] = await Promise.all([db().systemLog.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize }), db().systemLog.count({ where })]);
    const users = await db().user.findMany({ where: { id: { in: rows.map((r) => r.userId).filter((v): v is string => Boolean(v)) } }, select: { id: true, email: true } });
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        at: r.createdAt.toISOString(),
        level: r.level === "ERROR" ? "error" : r.level === "WARN" ? "warn" : "info",
        title: r.message.replace(/_/g, " "),
        subject: users.find((u) => u.id === r.userId)?.email ?? null,
        detail: compact(r.context),
        link: r.userId ? `/admin/users/${r.userId}` : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  if (kind === "provider") {
    const where: Prisma.ProviderRequestWhereInput = {
      success: false,
      ...between(filter),
      ...(q ? { OR: [{ action: { contains: q } }, { errorCategory: q.toUpperCase() }, { orderId: q }] } : {}),
    };
    const [rows, total] = await Promise.all([
      db().providerRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        select: { id: true, provider: true, action: true, errorCategory: true, errorCode: true, httpStatus: true, durationMs: true, attempt: true, orderId: true, createdAt: true },
      }),
      db().providerRequest.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: String(r.id),
        at: r.createdAt.toISOString(),
        level: r.errorCategory === "UNAUTHORIZED" ? "error" : "warn",
        title: `${r.provider} ${r.action} — ${r.errorCategory ?? "error"}`,
        subject: r.orderId ? `order ${r.orderId.slice(0, 8)}` : null,
        detail: [r.errorCode, r.httpStatus ? `HTTP ${r.httpStatus}` : null, `${r.durationMs} ms`, r.attempt > 1 ? `attempt ${r.attempt}` : null].filter(Boolean).join(" · "),
        link: r.orderId ? `/admin/orders/${r.orderId}` : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  if (kind === "payments") {
    const where: Prisma.PaymentEventWhereInput = { ...between(filter), ...(q ? { OR: [{ eventId: { contains: q } }, { type: { contains: q } }, { payment: { reference: q.toUpperCase() } }] } : {}) };
    const [rows, total] = await Promise.all([
      db().paymentEvent.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize, include: { payment: { select: { reference: true } } } }),
      db().paymentEvent.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        level: r.processedAt ? "info" : "warn",
        title: `${r.provider} webhook ${r.type}`,
        subject: r.payment?.reference ?? null,
        detail: `${r.eventId}${r.processedAt ? "" : " · not processed"}`,
        link: r.paymentId ? `/admin/payments/${r.paymentId}` : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  const where: Prisma.TransactionWhereInput = { type: "ADJUSTMENT", ...between(filter), ...(q ? { OR: [{ description: { contains: q } }, { user: { email: { contains: q.toLowerCase() } } }] } : {}) };
  const [rows, total] = await Promise.all([
    db().transaction.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: pageSize, include: { user: { select: { email: true } } } }),
    db().transaction.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      level: "info",
      title: `${toMinor(r.amount) >= 0 ? "+" : "−"}${toDecimalString(Math.abs(toMinor(r.amount)))} ${r.currency}`,
      subject: r.user.email,
      detail: r.description,
      link: `/admin/users/${r.userId}`,
    })),
    total,
    page,
    pageSize,
  };
}

/* -------------------------------------------------------------- settings -- */

export async function getPlatformSettings() {
  const [maintenance, manual, currencyMarkup, displayRates] = await Promise.all([
    getSetting("maintenance"),
    getSetting("manual_payment"),
    getSetting("currency_markup"),
    getDisplayRates(),
  ]);
  const e = env();
  return {
    maintenance,
    manual,
    currencyMarkup,
    displayRates,
    info: {
      currency: e.PLATFORM_CURRENCY,
      smsProvider: e.SMS_PROVIDER,
      paymentProvider: e.PAYMENT_PROVIDER,
      email: e.SMTP_HOST ? "SMTP" : "Outbox (development)",
      appUrl: e.APP_URL,
    },
  };
}

export async function saveMaintenance(actor: AdminActor, input: MaintenanceSetting): Promise<AdminResult> {
  const message = input.message.trim();
  const saved = await saveSetting("maintenance", { enabled: input.enabled, message });
  await audit(actor, `maintenance.${saved.enabled ? "enable" : "disable"}`, { type: "setting", id: "maintenance" }, true, { message }, `Maintenance mode turned ${saved.enabled ? "on" : "off"}`);
  return { ok: true, message: saved.enabled ? "Maintenance mode is ON: purchases and top-ups are paused." : "Maintenance mode is off." };
}

/** The Easypaisa / JazzCash account and WhatsApp contact shown on Add funds. */
export async function saveManualPayment(actor: AdminActor, input: ManualPaymentSetting): Promise<AdminResult> {
  const accountName = input.accountName.trim();
  const accountNumber = input.accountNumber.trim();
  const whatsapp = input.whatsapp?.trim() || null;
  if (accountName.length < 2 || accountName.length > 80) return { ok: false, message: "Enter the account holder's name." };
  if (!/^\+?[\d\s-]{7,20}$/.test(accountNumber)) return { ok: false, message: "Enter the Easypaisa / JazzCash number, e.g. 03246623395." };
  if (whatsapp && !whatsappDigits(whatsapp)) return { ok: false, message: "Enter the WhatsApp number, e.g. +923024966223 or 0302 4966223." };
  const before = await getSetting("manual_payment");
  const saved = await saveSetting("manual_payment", { accountName, accountNumber, whatsapp, note: input.note.trim() });
  await audit(actor, "manual_payment.update", { type: "setting", id: "manual_payment" }, true, { before, after: saved }, `Manual payment details changed to ${saved.accountName} · ${saved.accountNumber}`);
  return { ok: true, message: "Payment details saved." };
}

/** Max conversion tax / markup per currency (in units of that currency). */
const MAX_MARKUP = 100_000;

/**
 * Conversion tax / markup per display currency: ADDED TO THE EXCHANGE RATE
 * (1 USD = base + markup), then used for every converted amount on the site.
 * Display only — stored prices, charges and the ledger are never affected.
 */
export async function saveCurrencyMarkup(actor: AdminActor, input: Record<"PKR" | "INR" | "BDT", string>): Promise<AdminResult> {
  const clean = {} as CurrencyMarkupSetting;
  for (const code of ["PKR", "INR", "BDT"] as const) {
    const v = input[code].trim().replace(",", ".") || "0";
    if (!/^\d{1,6}(\.\d{1,4})?$/.test(v) || Number(v) > MAX_MARKUP) {
      return { ok: false, message: `Enter the ${code} conversion tax as a number from 0 to ${MAX_MARKUP.toLocaleString("en-US")} (up to 4 decimals), e.g. 5.` };
    }
    clean[code] = String(Number(v)); // "5.50" → "5.5", "007" → "7"
  }
  const before = await getSetting("currency_markup");
  const saved = await saveSetting("currency_markup", clean);
  await audit(
    actor,
    "currency_markup.update",
    { type: "setting", id: "currency_markup" },
    true,
    { before, after: saved },
    `Conversion tax set to PKR ${saved.PKR} · INR ${saved.INR} · BDT ${saved.BDT}`,
  );
  return { ok: true, message: "Conversion tax saved. Converted prices now use the new rates." };
}

/* ---------------------------------------------------------------- ledger -- */

const TX_TYPES = { deposit: "DEPOSIT", purchase: "PURCHASE", refund: "REFUND", adjustment: "ADJUSTMENT" } as const;

/** The whole ledger (every balance change on the platform), newest first. */
export async function listLedger(filter: {
  q?: string;
  type?: keyof typeof TX_TYPES;
  userId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 30));
  const q = filter.q?.trim();
  const where: Prisma.TransactionWhereInput = {
    ...(filter.type ? { type: TX_TYPES[filter.type] } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    ...between(filter),
    ...(q
      ? {
          OR: [
            { user: { email: { contains: q.toLowerCase() } } },
            { description: { contains: q } },
            { reference: { contains: q } },
            ...(/^[0-9a-f-]{4,36}$/i.test(q) ? [{ id: { startsWith: q.toLowerCase() } }] : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db().transaction.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { email: true } } } }),
    db().transaction.count({ where }),
  ]);
  return {
    items: rows.map((t) => {
      const actor = (t.metadata as { actor?: string } | null)?.actor;
      return {
        id: t.id,
        userId: t.userId,
        email: t.user.email,
        type: t.type.toLowerCase() as keyof typeof TX_TYPES,
        status: t.status.toLowerCase(),
        amount: toMinor(t.amount),
        balanceBefore: toMinor(t.balanceBefore),
        balanceAfter: toMinor(t.balanceAfter),
        currency: t.currency,
        reference: t.reference,
        description: t.description,
        source: t.orderId
          ? { kind: "order" as const, id: t.orderId }
          : t.paymentId
            ? { kind: "payment" as const, id: t.paymentId }
            : t.type === "ADJUSTMENT"
              ? { kind: actor ? ("admin" as const) : ("system" as const), id: actor ?? null }
              : { kind: "system" as const, id: null },
        createdAt: t.createdAt.toISOString(),
      };
    }),
    total,
    page,
    pageSize,
  };
}

/** Wallets with their owners, for finding and adjusting balances. */
export async function listWallets(filter: { q?: string; nonZero?: boolean; sort?: "balance_desc" | "balance_asc" | "updated"; page?: number; pageSize?: number }) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 30));
  const q = filter.q?.trim();
  const where: Prisma.WalletWhereInput = {
    ...(filter.nonZero ? { balance: { gt: 0 } } : {}),
    ...(q ? { user: { OR: [{ email: { contains: q.toLowerCase() } }, { name: { contains: q } }] } } : {}),
  };
  const orderBy: Prisma.WalletOrderByWithRelationInput =
    filter.sort === "balance_asc" ? { balance: "asc" } : filter.sort === "updated" ? { updatedAt: "desc" } : { balance: "desc" };
  const [rows, total, sum] = await Promise.all([
    db().wallet.findMany({ where, orderBy: [orderBy, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize, include: { user: { select: { id: true, email: true, name: true, status: true, deletedAt: true } } } }),
    db().wallet.count({ where }),
    db().wallet.aggregate({ where, _sum: { balance: true } }),
  ]);
  return {
    items: rows.map((w) => ({
      id: w.id,
      user: { id: w.user.id, email: w.user.email, name: w.user.name, status: w.user.deletedAt ? ("deleted" as const) : w.user.status === "ACTIVE" ? ("active" as const) : ("suspended" as const) },
      balance: toMinor(w.balance),
      currency: w.currency,
      updatedAt: w.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    sum: sum._sum.balance ? toMinor(sum._sum.balance) : 0,
  };
}

/* ------------------------------------------------------------ audit logs -- */

export async function listAuditLogs(filter: {
  q?: string;
  action?: string;
  actor?: string;
  targetType?: string;
  success?: boolean;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 30));
  const q = filter.q?.trim();
  const where: Prisma.AuditLogWhereInput = {
    ...(filter.action ? { action: { startsWith: filter.action } } : {}),
    ...(filter.actor ? { actorEmail: { contains: filter.actor.toLowerCase() } } : {}),
    ...(filter.targetType ? { targetType: filter.targetType } : {}),
    ...(filter.success !== undefined ? { success: filter.success } : {}),
    ...between(filter),
    ...(q ? { OR: [{ description: { contains: q } }, { targetId: { startsWith: q } }, { action: { contains: q } }] } : {}),
  };
  const [rows, total, actions] = await Promise.all([
    db().auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    db().auditLog.count({ where }),
    db().auditLog.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { action: "asc" } }),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r.id),
      action: r.action,
      description: r.description,
      actorEmail: r.actorEmail,
      targetType: r.targetType,
      targetId: r.targetId,
      success: r.success,
      metadata: r.metadata,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    actions: actions.map((a) => a.action),
  };
}
