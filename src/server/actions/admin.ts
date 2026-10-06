"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAdminActor, type AdminActor } from "@/server/admin/guard";
import { adminCancelOrder, adminRecheckPayment, adminRefreshOrder, adminResendPaymentWebhook, resolvePaymentReview } from "@/server/admin/orders";
import {
  saveMaintenance,
  savePricing,
  saveManualPayment,
  saveCurrencyMarkup,
  setCatalogItemActive,
  setServicePopular,
  triggerCatalogSync,
} from "@/server/admin/platform";
import {
  createReadyMadeOffer,
  deleteReadyMadeOffer,
  setReadyMadeOfferActive,
  updateReadyMadeOffer,
  type ReadyMadeOfferInput,
} from "@/server/admin/ready-made";
import { createBlogPost, deleteBlogPost, setBlogPostPublished, updateBlogPost, type BlogInput } from "@/server/admin/blog";
import { saveBlogImage } from "@/server/blog/images";
import { createMarginRule, deleteMarginRule, updateMarginRule, type MarginInput } from "@/server/admin/margins";
import { approveTopUp, rejectTopUp } from "@/server/admin/topups";
import {
  activateUser,
  adjustUserWallet,
  deleteUser,
  forceLogout,
  revokeUserApiKey,
  sendUserPasswordReset,
  setUserRole,
  suspendUser,
  updateUserProfile,
  type AdminResult,
} from "@/server/admin/users";
import { hitRateLimit, RATE_LIMITS } from "@/server/auth/rate-limit";
import type { FormState } from "@/types/forms";
import { saveCryptomusSettings, testCryptomusConnection } from "@/server/admin/payment-settings";

/**
 * Admin mutations. Each one re-verifies the admin from the session (the role
 * is re-read from the database), validates its input, and delegates to an
 * audited admin service. Nothing from the form (role flags, user ids of the
 * actor) is trusted beyond the target's id.
 */

const DENIED: FormState = { status: "error", message: "You don't have permission to do that." };
const INVALID: FormState = { status: "error", message: "Invalid request." };

const uuid = z.uuid();
const intId = z.coerce.number().int().positive().max(2_147_483_647);
const field = (data: FormData, name: string) => String(data.get(name) ?? "");

async function run(fn: (actor: AdminActor) => Promise<AdminResult | FormState>): Promise<FormState> {
  const actor = await getAdminActor();
  if (!actor) return DENIED;
  const limit = await hitRateLimit(`admin:actions:${actor.id}`, RATE_LIMITS.adminActionsPerAdmin);
  if (!limit.allowed) return { status: "error", message: "Too many admin actions in a short time. Please wait a minute." };
  try {
    const r = await fn(actor);
    if ("ok" in r) {
      revalidatePath("/admin", "layout");
      return { status: r.ok ? "success" : "error", message: r.message };
    }
    return r;
  } catch (error) {
    console.error("[admin] action failed:", error instanceof Error ? error.message : "unknown error");
    return { status: "error", message: "Something went wrong. Nothing was changed." };
  }
}

/* ----------------------------------------------------------------- users -- */

export async function adminSuspendUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => suspendUser(a, id.data, field(data, "reason").slice(0, 400)));
}

export async function adminActivateUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => activateUser(a, id.data));
}

export async function adminEditUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => updateUserProfile(a, id.data, { name: field(data, "name").slice(0, 100), email: field(data, "email").slice(0, 254) }));
}

export async function adminPasswordResetAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => sendUserPasswordReset(a, id.data));
}

export async function adminDeleteUserAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  const state = await run((a) => deleteUser(a, id.data, field(data, "confirmEmail").slice(0, 254)));
  // The account page no longer applies: go back to the list.
  return state.status === "success" ? { ...state, redirectTo: "/admin/users?deleted=1" } : state;
}

export async function adminUserRoleAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  const role = z.enum(["user", "admin"]).safeParse(field(data, "role"));
  if (!id.success || !role.success) return INVALID;
  return run((a) => setUserRole(a, id.data, role.data));
}

export async function adminForceLogoutAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => forceLogout(a, id.data));
}

export async function adminRevokeApiKeyAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "userId"));
  if (!id.success) return INVALID;
  return run((a) => revokeUserApiKey(a, id.data));
}

const adjustSchema = z.object({
  userId: z.uuid(),
  direction: z.enum(["credit", "debit"], { error: "Choose add or deduct." }),
  amount: z.string().trim().min(1, "Enter an amount.").max(20).regex(/^\d/, "Enter a positive amount; choose add or deduct above."),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(200),
  confirm: z.literal("on", { error: "Tick the confirmation box." }),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export async function adminAdjustWalletAction(_prev: FormState, data: FormData): Promise<FormState> {
  const parsed = adjustSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) {
    const fieldErrors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    return { status: "error", fieldErrors, values: { amount: field(data, "amount"), reason: field(data, "reason") } };
  }
  const { userId, amount, reason, idempotencyKey, direction } = parsed.data;
  const state = await run((a) => adjustUserWallet(a, userId, { amount, reason, idempotencyKey, direction }));
  return state.status === "error" ? { ...state, values: { amount, reason } } : state;
}

/* ------------------------------------------------------ orders & payments -- */

export async function adminRefreshOrderAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "orderId"));
  if (!id.success) return INVALID;
  return run((a) => adminRefreshOrder(a, id.data));
}

export async function adminCancelOrderAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "orderId"));
  if (!id.success) return INVALID;
  return run((a) => adminCancelOrder(a, id.data));
}

export async function adminRecheckPaymentAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "paymentId"));
  if (!id.success) return INVALID;
  return run((a) => adminRecheckPayment(a, id.data));
}

export async function adminResendWebhookAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "paymentId"));
  if (!id.success) return INVALID;
  return run((a) => adminResendPaymentWebhook(a, id.data));
}

export async function adminResolveReviewAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "paymentId"));
  if (!id.success) return INVALID;
  return run((a) => resolvePaymentReview(a, id.data, field(data, "note").slice(0, 400)));
}

/* --------------------------------------------------------------- catalog -- */

export async function adminCatalogToggleAction(_prev: FormState, data: FormData): Promise<FormState> {
  const kind = z.enum(["country", "service"]).safeParse(field(data, "kind"));
  const id = intId.safeParse(field(data, "id"));
  const active = z.enum(["true", "false"]).safeParse(field(data, "active"));
  if (!kind.success || !id.success || !active.success) return INVALID;
  return run((a) => setCatalogItemActive(a, kind.data, id.data, active.data === "true"));
}

export async function adminServicePopularAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  const popular = z.enum(["true", "false"]).safeParse(field(data, "popular"));
  if (!id.success || !popular.success) return INVALID;
  return run((a) => setServicePopular(a, id.data, popular.data === "true"));
}

export async function adminCatalogSyncAction(_prev: FormState, _data: FormData): Promise<FormState> {
  return run((a) => triggerCatalogSync(a));
}

/* -------------------------------------------------------------- settings -- */

export async function adminSavePricingAction(_prev: FormState, data: FormData): Promise<FormState> {
  return run((a) => savePricing(a, { markupPercent: field(data, "markupPercent"), minMargin: field(data, "minMargin") }));
}

export async function adminSaveMaintenanceAction(_prev: FormState, data: FormData): Promise<FormState> {
  const enabled = data.get("enabled") === "on";
  return run((a) => saveMaintenance(a, { enabled, message: field(data, "message").slice(0, 300) }));
}

export async function adminSaveManualPaymentAction(_prev: FormState, data: FormData): Promise<FormState> {
  return run((a) =>
    saveManualPayment(a, {
      accountName: field(data, "accountName").slice(0, 80),
      accountNumber: field(data, "accountNumber").slice(0, 20),
      whatsapp: field(data, "whatsapp").slice(0, 20) || null,
      note: field(data, "note").slice(0, 200),
    }),
  );
}

export async function adminSaveCurrencyMarkupAction(_prev: FormState, data: FormData): Promise<FormState> {
  const result = await run((a) =>
    saveCurrencyMarkup(a, { PKR: field(data, "PKR").slice(0, 20), INR: field(data, "INR").slice(0, 20), BDT: field(data, "BDT").slice(0, 20) }),
  );
  // Every page shows converted prices: refresh them all, not only the admin panel.
  if (result.status === "success") revalidatePath("/", "layout");
  return result;
}

const secret = (data: FormData, name: string) => ({ value: field(data, name).slice(0, 600), clear: data.get(`${name}Clear`) === "on" });

/** Cryptomus settings. Credential fields are write-only: blank keeps the saved value. */
export async function adminSaveCryptomusAction(_prev: FormState, data: FormData): Promise<FormState> {
  const result = await run((a) =>
    saveCryptomusSettings(a, {
      enabled: data.get("enabled") === "on",
      merchantId: secret(data, "merchantId"),
      paymentKey: secret(data, "paymentKey"),
      payoutKey: secret(data, "payoutKey"),
      displayName: field(data, "displayName").slice(0, 80),
      description: field(data, "description").slice(0, 300),
      minAmount: field(data, "minAmount").slice(0, 20),
      maxAmount: field(data, "maxAmount").slice(0, 20),
      feeFixed: field(data, "feeFixed").slice(0, 20),
      feePercent: field(data, "feePercent").slice(0, 20),
      sortOrder: field(data, "sortOrder").slice(0, 5),
      webhookUrl: field(data, "webhookUrl").slice(0, 300),
      verifyIp: data.get("verifyIp") === "on",
      lifetimeMinutes: field(data, "lifetimeMinutes").slice(0, 5),
    }),
  );
  // The add-funds page lists the enabled providers.
  if (result.status === "success") revalidatePath("/profile/top-up");
  return result;
}

/** Tests the typed (or saved) Merchant UUID + Payment API key with a read-only signed request. */
export async function adminTestCryptomusAction(_prev: FormState, data: FormData): Promise<FormState> {
  return run((a) => testCryptomusConnection(a, { merchantId: field(data, "merchantId").slice(0, 600), paymentKey: field(data, "paymentKey").slice(0, 600) }));
}

/* ------------------------------------------------------- manual top-ups -- */

export async function adminApproveTopUpAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "paymentId"));
  if (!id.success) return INVALID;
  return run((a) => approveTopUp(a, id.data));
}

export async function adminRejectTopUpAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = uuid.safeParse(field(data, "paymentId"));
  if (!id.success) return INVALID;
  return run((a) => rejectTopUp(a, id.data, field(data, "reason").slice(0, 400)));
}

/* ------------------------------------------------- ready made accounts -- */

/** Parses the offer form; "all" is the All-countries choice. Ids are re-checked in the service. */
function readyMadeInput(data: FormData): ReadyMadeOfferInput | null {
  const serviceId = intId.safeParse(field(data, "serviceId"));
  const countryRaw = field(data, "countryId");
  const countryId = countryRaw === "all" ? null : intId.safeParse(countryRaw);
  if (!serviceId.success || (countryId !== null && !countryId.success)) return null;
  return {
    serviceId: serviceId.data,
    countryId: countryId === null ? null : countryId.data,
    price: field(data, "price").trim().slice(0, 20),
    availableQuantity: field(data, "availableQuantity").trim().slice(0, 12),
    isActive: data.get("isActive") === "on",
  };
}

export async function adminReadyMadeCreateAction(_prev: FormState, data: FormData): Promise<FormState> {
  const input = readyMadeInput(data);
  if (!input) return { status: "error", message: "Choose a service and a country (or All countries)." };
  return run((a) => createReadyMadeOffer(a, input));
}

export async function adminReadyMadeUpdateAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  const input = readyMadeInput(data);
  if (!id.success) return INVALID;
  if (!input) return { status: "error", message: "Choose a service and a country (or All countries)." };
  const result = await run((a) => updateReadyMadeOffer(a, id.data, input));
  return result.status === "success" ? { ...result, redirectTo: "/admin/ready-made-accounts" } : result;
}

export async function adminReadyMadeToggleAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  const active = z.enum(["true", "false"]).safeParse(field(data, "active"));
  if (!id.success || !active.success) return INVALID;
  return run((a) => setReadyMadeOfferActive(a, id.data, active.data === "true"));
}

export async function adminReadyMadeDeleteAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  if (!id.success) return INVALID;
  return run((a) => deleteReadyMadeOffer(a, id.data));
}

/* ------------------------------------------------------- custom margins -- */

function marginInput(data: FormData): MarginInput | null {
  const serviceId = intId.safeParse(field(data, "serviceId"));
  const countryId = intId.safeParse(field(data, "countryId"));
  if (!serviceId.success || !countryId.success) return null;
  return { serviceId: serviceId.data, countryId: countryId.data, minMargin: field(data, "minMargin").trim().slice(0, 12) };
}

export async function adminMarginCreateAction(_prev: FormState, data: FormData): Promise<FormState> {
  const input = marginInput(data);
  if (!input) return { status: "error", message: "Choose a service and a country." };
  return run((a) => createMarginRule(a, input));
}

export async function adminMarginUpdateAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  const input = marginInput(data);
  if (!id.success) return INVALID;
  if (!input) return { status: "error", message: "Choose a service and a country." };
  return run((a) => updateMarginRule(a, id.data, input));
}

export async function adminMarginDeleteAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  if (!id.success) return INVALID;
  return run((a) => deleteMarginRule(a, id.data));
}

/* ------------------------------------------------------------------ blog -- */

/** Reads the post form. A newly chosen image file wins over the image URL field; "removeImage" clears it. */
async function blogInput(data: FormData): Promise<{ ok: true; input: BlogInput } | { ok: false; message: string }> {
  let featuredImage = data.get("removeImage") === "on" ? "" : field(data, "featuredImage").trim().slice(0, 500);
  const file = data.get("imageFile");
  if (file instanceof File && file.size > 0) {
    const saved = await saveBlogImage(file);
    if (!saved.ok) return saved;
    featuredImage = saved.url;
  }
  return {
    ok: true,
    input: {
      title: field(data, "title").slice(0, 300),
      slug: field(data, "slug").slice(0, 200),
      excerpt: field(data, "excerpt").slice(0, 800),
      content: field(data, "content").slice(0, 210_000),
      category: field(data, "category").slice(0, 100),
      featuredImage,
      publishedAt: field(data, "publishedAt").slice(0, 40),
      intent: field(data, "intent") === "publish" ? "publish" : "draft",
    },
  };
}

export async function adminBlogCreateAction(_prev: FormState, data: FormData): Promise<FormState> {
  if (!(await getAdminActor())) return DENIED;
  const parsed = await blogInput(data);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const result = await run((a) => createBlogPost(a, parsed.input));
  return result.status === "success" ? { ...result, redirectTo: "/admin/blog" } : result;
}

export async function adminBlogUpdateAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  if (!id.success) return INVALID;
  if (!(await getAdminActor())) return DENIED;
  const parsed = await blogInput(data);
  if (!parsed.ok) return { status: "error", message: parsed.message };
  const result = await run((a) => updateBlogPost(a, id.data, parsed.input));
  return result.status === "success" ? { ...result, redirectTo: "/admin/blog" } : result;
}

export async function adminBlogPublishAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  const publish = z.enum(["true", "false"]).safeParse(field(data, "publish"));
  if (!id.success || !publish.success) return INVALID;
  return run((a) => setBlogPostPublished(a, id.data, publish.data === "true"));
}

export async function adminBlogDeleteAction(_prev: FormState, data: FormData): Promise<FormState> {
  const id = intId.safeParse(field(data, "id"));
  if (!id.success) return INVALID;
  return run((a) => deleteBlogPost(a, id.data));
}
