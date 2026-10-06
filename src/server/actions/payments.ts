"use server";

import { z } from "zod";
import { getCurrentUser } from "@/server/auth/session";
import { createManualTopUp, createTopUp, verifyTopUp, type TopUpResult } from "@/server/services/payment.service";

/**
 * Top-up actions. The user comes from the session; amount, fee and currency
 * are decided by the payment service. Nothing here marks a payment paid.
 */

const SIGN_IN: TopUpResult = { ok: false, code: "INVALID", message: "Please log in to continue." };
const FAILED: TopUpResult = { ok: false, code: "PROVIDER_ERROR", message: "Something went wrong. Please try again." };

const createSchema = z.object({
  amount: z.string().max(20),
  method: z.string().regex(/^[a-z0-9_]{1,32}$/),
  /** Which provider offers the method ("cryptomus", …); optional when only one does. */
  provider: z.string().regex(/^[a-z0-9_]{1,32}$/).optional(),
  /** Generated once per attempt so a double submit can't start two payments. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

export async function createTopUpAction(input: unknown): Promise<TopUpResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID", message: "Invalid request." };
  const user = await getCurrentUser();
  if (!user) return SIGN_IN;
  try {
    return await createTopUp(user.id, parsed.data);
  } catch (error) {
    console.error("[payments] create failed:", error instanceof Error ? error.message : "unknown error");
    return FAILED;
  }
}

export async function verifyTopUpAction(paymentId: unknown): Promise<TopUpResult> {
  const id = z.uuid().safeParse(paymentId);
  if (!id.success) return { ok: false, code: "NOT_FOUND", message: "Payment not found." };
  const user = await getCurrentUser();
  if (!user) return SIGN_IN;
  try {
    return await verifyTopUp(user.id, id.data);
  } catch (error) {
    console.error("[payments] verify failed:", error instanceof Error ? error.message : "unknown error");
    return FAILED;
  }
}

const manualSchema = z.object({
  amount: z.string().max(20),
  method: z.enum(["easypaisa", "jazzcash"]),
  transactionId: z.string().max(60),
  note: z.string().max(300).optional(),
  /** Generated once per form so a double submit creates one request. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});

/** Manual Easypaisa / JazzCash request. Never credits — an administrator approves it. */
export async function createManualTopUpAction(input: unknown): Promise<TopUpResult> {
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID", message: "Check the amount, method and transaction ID." };
  const user = await getCurrentUser();
  if (!user) return SIGN_IN;
  try {
    return await createManualTopUp(user.id, parsed.data);
  } catch (error) {
    console.error("[payments] manual request failed:", error instanceof Error ? error.message : "unknown error");
    return FAILED;
  }
}
