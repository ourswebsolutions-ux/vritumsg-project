import "server-only";
import { randomBytes } from "node:crypto";
import { formatMoney, parseAmount, toDecimalString, toMinor } from "@/lib/money";
import { emailSchema, nameSchema } from "@/lib/validation/auth";
import { hashPassword } from "@/server/auth/password";
import { deleteUserSessions } from "@/server/auth/session";
import { db, isUniqueViolation, type Prisma } from "@/server/db";
import { revokeApiKey } from "@/server/services/api-key.service";
import * as auth from "@/server/services/auth.service";
import { platformCurrency } from "@/server/services/currency";
import { applyInTx, totalsByType, WalletError } from "@/server/services/wallet.service";
import type { AdminPage, AdminUserDetail, AdminUserRow } from "@/types/admin";
import { audit, auditInTx } from "./audit";
import type { AdminActor } from "./guard";

/** Admin user management. Every mutation takes the verified actor and is audited. */

export type AdminResult = { ok: true; message: string } | { ok: false; message: string };

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  deletedAt: true,
  createdAt: true,
  wallet: { select: { balance: true, currency: true } },
  _count: { select: { orders: true } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

const statusOf = (u: { status: string; deletedAt: Date | null }): AdminUserRow["status"] =>
  u.deletedAt ? "deleted" : u.status === "ACTIVE" ? "active" : "suspended";

function toRow(u: UserRow, extra: { lastLoginAt?: Date | null; spent?: number } = {}): AdminUserRow {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role === "ADMIN" ? "admin" : "user",
    status: statusOf(u),
    emailVerified: Boolean(u.emailVerifiedAt),
    balance: u.wallet ? toMinor(u.wallet.balance) : 0,
    currency: u.wallet?.currency ?? platformCurrency().code,
    orders: u._count.orders,
    spent: extra.spent ?? 0,
    lastLoginAt: extra.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export type UserFilter = {
  q?: string;
  role?: "user" | "admin";
  status?: "active" | "suspended" | "deleted";
  sort?: "newest" | "oldest" | "name" | "balance_desc" | "balance_asc";
  page?: number;
  pageSize?: number;
};

const SORTS: Record<NonNullable<UserFilter["sort"]>, Prisma.UserOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }, { id: "asc" }],
  oldest: [{ createdAt: "asc" }, { id: "asc" }],
  name: [{ name: "asc" }, { id: "asc" }],
  balance_desc: [{ wallet: { balance: "desc" } }, { id: "asc" }],
  balance_asc: [{ wallet: { balance: "asc" } }, { id: "asc" }],
};

/** Last successful login and net spending (purchases − refunds) for a page of users. */
async function activityFor(ids: string[]) {
  if (!ids.length) return { logins: new Map<string, Date>(), spent: new Map<string, number>() };
  const [logins, ledger] = await Promise.all([
    db().systemLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, source: "auth", message: "login_success" }, _max: { createdAt: true } }),
    db().transaction.groupBy({ by: ["userId"], where: { userId: { in: ids }, status: "COMPLETED", type: { in: ["PURCHASE", "REFUND"] } }, _sum: { amount: true } }),
  ]);
  return {
    logins: new Map(logins.filter((l) => l.userId && l._max.createdAt).map((l) => [l.userId!, l._max.createdAt!])),
    spent: new Map(ledger.map((l) => [l.userId, l._sum.amount ? -toMinor(l._sum.amount) : 0])),
  };
}

export async function listUsers(filter: UserFilter = {}): Promise<AdminPage<AdminUserRow>> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
  const q = filter.q?.trim();
  const where: Prisma.UserWhereInput = {
    ...(filter.role ? { role: filter.role === "admin" ? "ADMIN" : "USER" } : {}),
    // Deleted (anonymized) accounts only show when asked for.
    ...(filter.status === "deleted" ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...(filter.status === "active" ? { status: "ACTIVE" } : filter.status === "suspended" ? { status: "SUSPENDED" } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q.toLowerCase() } },
            { name: { contains: q } },
            ...(/^[0-9a-f-]{4,36}$/i.test(q) ? [{ id: { startsWith: q.toLowerCase() } }] : []),
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    db().user.findMany({ where, select: userSelect, orderBy: SORTS[filter.sort ?? "newest"], skip: (page - 1) * pageSize, take: pageSize }),
    db().user.count({ where }),
  ]);
  const act = await activityFor(rows.map((r) => r.id));
  return { items: rows.map((r) => toRow(r, { lastLoginAt: act.logins.get(r.id), spent: act.spent.get(r.id) })), total, page, pageSize };
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail | null> {
  const u = await db().user.findUnique({
    where: { id: userId },
    select: { ...userSelect, apiKeyHash: true, suspensionReason: true, suspendedAt: true, suspendedById: true },
  });
  if (!u) return null;
  const [totals, byStatus, lastSession, sessions, payments, act, history, security] = await Promise.all([
    totalsByType(userId),
    db().order.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    db().session.findFirst({ where: { userId }, orderBy: { lastUsedAt: "desc" }, select: { lastUsedAt: true } }),
    db().session.count({ where: { userId, expiresAt: { gt: new Date() } } }),
    db().payment.groupBy({ by: ["status"], where: { userId }, _count: { _all: true }, _sum: { amount: true } }),
    activityFor([userId]),
    db().auditLog.findMany({ where: { targetType: "user", targetId: userId }, orderBy: { createdAt: "desc" }, take: 15 }),
    db().systemLog.findMany({ where: { userId, source: "auth" }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const suspendedBy = u.suspendedById ? await db().user.findUnique({ where: { id: u.suspendedById }, select: { email: true } }) : null;
  const count = (s: string[]) => byStatus.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
  const pay = (s: string[]) => payments.filter((g) => s.includes(g.status)).reduce((n, g) => n + g._count._all, 0);
  const paid = payments.find((g) => g.status === "PAID");
  return {
    ...toRow(u, { lastLoginAt: act.logins.get(userId), spent: act.spent.get(userId) }),
    lastActiveAt: lastSession?.lastUsedAt.toISOString() ?? null,
    activeSessions: sessions,
    hasApiKey: Boolean(u.apiKeyHash),
    suspension:
      u.suspendedAt && u.status === "SUSPENDED"
        ? { reason: u.suspensionReason, at: u.suspendedAt.toISOString(), by: suspendedBy?.email ?? null }
        : null,
    totals: {
      deposits: totals.DEPOSIT ?? 0,
      purchases: totals.PURCHASE ?? 0,
      refunds: totals.REFUND ?? 0,
      adjustments: totals.ADJUSTMENT ?? 0,
    },
    orderCounts: {
      total: count(["PENDING", "ACTIVE", "SMS_RECEIVED", "COMPLETED", "CANCELLED", "REFUNDED", "EXPIRED", "FAILED"]),
      completed: count(["COMPLETED"]),
      active: count(["PENDING", "ACTIVE", "SMS_RECEIVED"]),
      cancelled: count(["CANCELLED", "REFUNDED", "EXPIRED"]),
      failed: count(["FAILED"]),
    },
    paymentCounts: {
      pending: pay(["PENDING", "PROCESSING"]),
      approved: pay(["PAID"]),
      rejected: pay(["REJECTED", "FAILED", "CANCELLED", "EXPIRED", "UNDERPAID"]),
      totalPaid: paid?._sum.amount ? toMinor(paid._sum.amount) : 0,
    },
    history: history.map((h) => ({
      id: String(h.id),
      action: h.action,
      description: h.description,
      actorEmail: h.actorEmail,
      success: h.success,
      createdAt: h.createdAt.toISOString(),
    })),
    security: security.map((s) => ({ id: String(s.id), event: s.message, level: s.level, createdAt: s.createdAt.toISOString() })),
  };
}

/* --------------------------------------------------------------- actions -- */

async function target(userId: string) {
  return db().user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, status: true, deletedAt: true } });
}

async function otherActiveAdmins(exceptId: string) {
  return db().user.count({ where: { role: "ADMIN", status: "ACTIVE", deletedAt: null, id: { not: exceptId } } });
}

const T = (id: string) => ({ type: "user", id });

export async function suspendUser(actor: AdminActor, userId: string, reason: string): Promise<AdminResult> {
  const why = reason.trim();
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  if (why.length < 5 || why.length > 300) return { ok: false, message: "Give a suspension reason (5–300 characters)." };
  if (u.id === actor.id) {
    await audit(actor, "user.suspend", T(userId), false, { reason: "self" }, "Refused: an admin can't suspend themselves");
    return { ok: false, message: "You can't suspend your own account." };
  }
  if (u.role === "ADMIN" && (await otherActiveAdmins(u.id)) === 0) {
    await audit(actor, "user.suspend", T(userId), false, { reason: "last_admin" }, "Refused: last active administrator");
    return { ok: false, message: "This is the last active administrator." };
  }
  if (u.status === "SUSPENDED") return { ok: false, message: "This account is already suspended." };
  await db().user.update({ where: { id: userId }, data: { status: "SUSPENDED", suspensionReason: why, suspendedById: actor.id, suspendedAt: new Date() } });
  // Locked out at once: sessions are revoked (and suspended accounts are rejected on every request anyway).
  const revoked = await deleteUserSessions(userId);
  await audit(actor, "user.suspended", T(userId), true, { reason: why, sessionsRevoked: revoked }, `Suspended ${u.email}: ${why}`);
  return { ok: true, message: "Account suspended and logged out everywhere." };
}

export async function activateUser(actor: AdminActor, userId: string): Promise<AdminResult> {
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  if (u.status === "ACTIVE") return { ok: false, message: "This account is already active." };
  await db().user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  await audit(actor, "user.activated", T(userId), true, {}, `Re-activated ${u.email}`);
  return { ok: true, message: "Account re-activated." };
}

/** Back-compat for the JSON API ({ status: "active" | "suspended" }). */
export async function setUserStatus(actor: AdminActor, userId: string, status: "active" | "suspended", reason = "Suspended by an administrator"): Promise<AdminResult> {
  return status === "active" ? activateUser(actor, userId) : suspendUser(actor, userId, reason);
}

export async function setUserRole(actor: AdminActor, userId: string, role: "user" | "admin"): Promise<AdminResult> {
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  if (u.id === actor.id) {
    await audit(actor, "user.role", T(userId), false, { to: role, reason: "self" }, "Refused: an admin can't change their own role");
    return { ok: false, message: "You can't change your own role." };
  }
  if (role === "user" && u.role === "ADMIN" && (await otherActiveAdmins(u.id)) === 0) {
    await audit(actor, "user.role", T(userId), false, { to: role, reason: "last_admin" }, "Refused: last active administrator");
    return { ok: false, message: "This is the last active administrator." };
  }
  await db().user.update({ where: { id: userId }, data: { role: role === "admin" ? "ADMIN" : "USER" } });
  await audit(actor, "user.role", T(userId), true, { from: u.role.toLowerCase(), to: role }, `${u.email} is now ${role === "admin" ? "an administrator" : "a regular user"}`);
  return { ok: true, message: role === "admin" ? "User is now an administrator." : "Administrator rights removed." };
}

export async function updateUserProfile(actor: AdminActor, userId: string, input: { name: string; email: string }): Promise<AdminResult> {
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  const name = nameSchema.safeParse(input.name);
  const email = emailSchema.safeParse(input.email);
  if (!name.success) return { ok: false, message: "Enter a valid name." };
  if (!email.success) return { ok: false, message: "Enter a valid email address." };
  if (name.data === u.name && email.data === u.email) return { ok: false, message: "Nothing changed." };
  try {
    await db().user.update({ where: { id: userId }, data: { name: name.data, email: email.data } });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, message: "Another account already uses that email." };
    throw error;
  }
  if (email.data !== u.email) await deleteUserSessions(userId); // log in again with the new address
  await audit(actor, "user.updated", T(userId), true, { before: { name: u.name, email: u.email }, after: { name: name.data, email: email.data } }, `Edited ${u.email}`);
  return { ok: true, message: email.data !== u.email ? "Saved. The user was logged out and must use the new email." : "Saved." };
}

/** Emails the user a password-reset link (the admin never sees or sets the password). */
export async function sendUserPasswordReset(actor: AdminActor, userId: string): Promise<AdminResult> {
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  const r = await auth.requestPasswordReset(u.email, { ip: actor.ip ?? "unknown", userAgent: "admin" });
  if (!r.ok) {
    await audit(actor, "user.password_reset_sent", T(userId), false, { error: r.code });
    return { ok: false, message: "Too many reset emails for this address. Try again later." };
  }
  await audit(actor, "user.password_reset_sent", T(userId), true, {}, `Password-reset link emailed to ${u.email}`);
  return { ok: true, message: `A password-reset link was emailed to ${u.email}.` };
}

export async function forceLogout(actor: AdminActor, userId: string): Promise<AdminResult> {
  const u = await target(userId);
  if (!u) return { ok: false, message: "User not found." };
  const count = await deleteUserSessions(userId, u.id === actor.id ? { except: actor.sessionId } : {});
  await audit(actor, "user.force_logout", T(userId), true, { sessionsRevoked: count }, `Logged ${u.email} out of ${count} session(s)`);
  return { ok: true, message: count ? `Logged out of ${count} session${count === 1 ? "" : "s"}.` : "No active sessions." };
}

export async function revokeUserApiKey(actor: AdminActor, userId: string): Promise<AdminResult> {
  const u = await target(userId);
  if (!u) return { ok: false, message: "User not found." };
  await revokeApiKey(userId);
  await audit(actor, "user.api_key_revoked", T(userId), true, {}, `Revoked the API key of ${u.email}`);
  return { ok: true, message: "API key revoked." };
}

/**
 * Deletes an account safely. Refused while money or live activity depends on
 * it (non-zero balance, pending top-ups, live orders), for admins, and
 * without the typed email confirmation. Accounts with financial or order
 * history are anonymized (their ledger, orders and payments stay intact for
 * accounting); accounts without any history are removed completely.
 */
export async function deleteUser(actor: AdminActor, userId: string, confirmEmail: string): Promise<AdminResult> {
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };
  const refuse = async (message: string, why: string) => {
    await audit(actor, "user.delete", T(userId), false, { reason: why }, `Refused to delete ${u.email}: ${message}`);
    return { ok: false as const, message };
  };
  if (confirmEmail.trim().toLowerCase() !== u.email) return { ok: false, message: "Type the user's email exactly to confirm." };
  if (u.id === actor.id) return refuse("You can't delete your own account.", "self");
  if (u.role === "ADMIN") return refuse("Remove this user's administrator role first.", "admin");

  const [wallet, pendingTopUps, liveOrders, history] = await Promise.all([
    db().wallet.findUnique({ where: { userId }, select: { balance: true, currency: true } }),
    db().payment.count({ where: { userId, status: { in: ["PENDING", "PROCESSING"] } } }),
    db().order.count({ where: { userId, status: { in: ["PENDING", "ACTIVE", "SMS_RECEIVED"] } } }),
    Promise.all([db().transaction.count({ where: { userId } }), db().order.count({ where: { userId } }), db().payment.count({ where: { userId } })]),
  ]);
  const balance = wallet ? toMinor(wallet.balance) : 0;
  if (balance !== 0) return refuse(`The wallet still holds ${formatMoney(balance, wallet!.currency)}. Refund or adjust it to zero first.`, "balance");
  if (pendingTopUps) return refuse("Review this user's pending top-up requests first.", "pending_topups");
  if (liveOrders) return refuse("Wait for this user's live numbers to finish first.", "live_orders");

  const hasHistory = history.some((n) => n > 0);
  if (hasHistory) {
    await db().$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          name: "Deleted user",
          email: `deleted+${userId}@deleted.invalid`,
          passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
          apiKeyHash: null,
          apiKeyHint: null,
          apiKeyCreatedAt: null,
          status: "SUSPENDED",
          suspensionReason: "Account deleted",
          suspendedById: actor.id,
          suspendedAt: new Date(),
          deletedAt: new Date(),
        },
      });
      await tx.session.deleteMany({ where: { userId } });
      await tx.authToken.deleteMany({ where: { userId } });
      await auditInTx(tx, actor, {
        action: "user.deleted",
        target: T(userId),
        success: true,
        metadata: { mode: "anonymized", transactions: history[0], orders: history[1], payments: history[2] },
        description: `Deleted ${u.email} (anonymized; financial history kept)`,
      });
    });
    return { ok: true, message: "Account deleted. Personal data was removed; orders and ledger entries are kept for accounting." };
  }

  await db().$transaction(async (tx) => {
    await tx.wallet.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } }); // sessions/tokens cascade; applications keep a null user
    await auditInTx(tx, actor, { action: "user.deleted", target: T(userId), success: true, metadata: { mode: "hard" }, description: `Deleted ${u.email} (no history, removed completely)` });
  });
  return { ok: true, message: "Account deleted." };
}

const MAX_ADJUSTMENT = 10_000 * 10_000; // 10,000 units of currency per adjustment

/**
 * Manual balance correction through the ledger (never a direct balance edit).
 * The ledger row and the audit record commit together. The idempotency key
 * makes a double-submitted form apply once; the ledger refuses to take a
 * balance below zero.
 */
export async function adjustUserWallet(
  actor: AdminActor,
  userId: string,
  input: { amount: string; reason: string; idempotencyKey: string; direction?: "credit" | "debit" },
): Promise<AdminResult> {
  const t = T(userId);
  const raw = input.amount.trim().replace(",", ".");
  const negative = raw.startsWith("-");
  const minor = parseAmount(negative ? raw.slice(1) : raw.replace(/^\+/, ""));
  const reason = input.reason.trim();
  if (minor === null || minor === 0 || minor > MAX_ADJUSTMENT) {
    return { ok: false, message: "Enter a non-zero amount like 5 or 2.50 (up to 10,000)." };
  }
  if (reason.length < 5 || reason.length > 200) return { ok: false, message: "Give a reason (5–200 characters)." };
  const u = await target(userId);
  if (!u || u.deletedAt) return { ok: false, message: "User not found." };

  const direction = input.direction ?? (negative ? "debit" : "credit");
  const amount = direction === "debit" ? -minor : minor;
  const meta = { amount: toDecimalString(amount), reason };
  try {
    const { duplicate, entry } = await db().$transaction(async (tx) => {
      const r = await applyInTx(
        tx,
        {
          userId,
          amount: minor,
          type: "ADJUSTMENT",
          reference: `admin:adjust:${input.idempotencyKey}`,
          description: `Manual adjustment — ${reason}`.slice(0, 255),
          metadata: { actor: actor.id, reason },
        },
        direction === "debit" ? -1 : 1,
      );
      if (!r.duplicate) {
        await auditInTx(tx, actor, {
          action: direction === "debit" ? "wallet.debited" : "wallet.credited",
          target: t,
          success: true,
          metadata: { ...meta, transactionId: r.entry.id, balanceAfter: toDecimalString(r.entry.balanceAfter) },
          description: `${direction === "debit" ? "Deducted" : "Added"} ${formatMoney(minor, r.entry.currency)} ${direction === "debit" ? "from" : "to"} ${u.email}: ${reason}`,
        });
      }
      return r;
    });
    if (duplicate) return { ok: true, message: "This adjustment was already applied." };
    return { ok: true, message: `Balance ${direction === "debit" ? "debited" : "credited"}. New balance ${formatMoney(entry.balanceAfter, entry.currency)}.` };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: true, message: "This adjustment was already applied." };
    const message =
      error instanceof WalletError && error.code === "INSUFFICIENT_FUNDS"
        ? "That would make the balance negative."
        : error instanceof WalletError && error.code === "REFERENCE_CONFLICT"
          ? "This form was already used. Reload and try again."
          : "The adjustment failed. Nothing was changed.";
    await audit(actor, direction === "debit" ? "wallet.debit" : "wallet.credit", t, false, { ...meta, error: error instanceof WalletError ? error.code : "INTERNAL" }, `Failed balance change for ${u.email}`);
    return { ok: false, message };
  }
}
