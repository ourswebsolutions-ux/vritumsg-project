"use client";

import { useActionState } from "react";
import { initialFormState, type FormState } from "@/types/forms";

type ServerAction = (prev: FormState, data: FormData) => Promise<FormState>;

const SECRET_FIELDS = /password|confirm|current|next$|token|merchantId|paymentKey|payoutKey/i;

/**
 * useActionState plus the behaviour every auth form needs:
 *  - optional client-side validation with the same rules as the server
 *    (errors show instantly, no request is sent);
 *  - network failures become a readable error instead of an exception;
 *  - `redirectTo` from the server triggers a full navigation, so the header
 *    re-renders with the new session.
 */
export function useFormAction(
  action: ServerAction,
  validate?: (data: FormData) => Record<string, string> | null,
) {
  return useActionState<FormState, FormData>(async (prev, data) => {
    const keep = (): Record<string, string> =>
      Object.fromEntries(
        [...data.entries()].filter(([k, v]) => typeof v === "string" && !SECRET_FIELDS.test(k)) as [string, string][],
      );

    const clientErrors = validate?.(data);
    if (clientErrors && Object.keys(clientErrors).length) {
      return { status: "error", fieldErrors: clientErrors, values: keep() };
    }
    try {
      const result = await action(prev, data);
      if (result.redirectTo) window.location.assign(result.redirectTo);
      return result;
    } catch {
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      return {
        status: "error",
        code: "network",
        values: keep(),
        message: offline
          ? "You appear to be offline. Check your connection and try again."
          : "We couldn't reach the server. Please try again.",
      };
    }
  }, initialFormState);
}
