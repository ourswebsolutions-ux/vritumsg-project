"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Icon, type IconName } from "@/components/icons";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatPrice } from "@/lib/format";
import { MONEY_SCALE, parseAmount, toMinor, topUpFeeFor } from "@/lib/money";
import { createTopUpAction } from "@/server/actions/payments";
import type { TopUpResult } from "@/server/services/payment.service";
import type { TopUpProviderOption } from "@/types/account";
import { useT } from "@/i18n/client";
import { ConvertedAmount, Money } from "@/components/currency/DisplayCurrency";

const KIND_ICON: Record<string, IconName> = {
  card: "wallet",
  bank_transfer: "globe",
  local: "phone",
  crypto: "lock",
  wallet: "wallet",
  test: "cpu",
};

function newKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const unitsLabel = (minor: number) => String(minor / MONEY_SCALE);

/**
 * Add-funds form for one redirect provider (e.g. Cryptomus): amount (presets
 * or custom), payment method and a live summary. The preview mirrors the
 * server's fee rule; the server recomputes and validates everything when the
 * payment is created, and only the provider's verified webhook credits.
 */
export function TopUpForm({ options, balance }: { options: TopUpProviderOption; balance: number }) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amountInput, setAmountInput] = useState(() =>
    unitsLabel(options.presets.find((p) => p === 10 * MONEY_SCALE) ?? options.presets[0] ?? options.min),
  );
  const [method, setMethod] = useState(options.methods[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  // One key per attempt: a double submit or a retry after a lost response
  // returns the same payment instead of starting a second one.
  const [key, setKey] = useState(newKey);

  const feeBps = toMinor(options.feePercent) / 100;
  const amount = parseAmount(amountInput.trim().replace(",", "."));
  const invalid =
    amount === null || amount % (MONEY_SCALE / 100) !== 0
      ? t("srv.pay.amountFormat")
      : amount < options.min || amount > options.max
        ? t("topup.amountBetween", { min: formatPrice(options.min, options.currency), max: formatPrice(options.max, options.currency) })
        : null;
  const quote = useMemo(() => {
    if (invalid || amount === null) return null;
    const fee = topUpFeeFor(amount, feeBps, options.feeFixed);
    return { fee, total: amount + fee };
  }, [amount, invalid, feeBps, options.feeFixed]);
  const hasFee = feeBps > 0 || options.feeFixed > 0;
  const crypto = options.id === "cryptomus";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid || !method) return;
    setError(null);
    startTransition(async () => {
      let r: TopUpResult;
      try {
        r = await createTopUpAction({ amount: amountInput.trim(), method, provider: options.id, idempotencyKey: key });
      } catch {
        // Unknown whether it was created: keep the key so a retry can't create a second payment.
        setError(t("topup.unreachableTry"));
        return;
      }
      if (!r.ok) {
        setError(t.server(r.message));
        setKey(newKey());
        return;
      }
      if (r.redirectUrl) window.location.assign(r.redirectUrl);
      else router.push(`/profile/top-up/${r.payment.id}`);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-6" aria-label={t("nav.addFunds")}>
      {options.test && (
        <Alert tone="warning" title={t("topup.testMode")}>
          {t("topup.testModeBody")}
        </Alert>
      )}

      {crypto && (
        <div className="flex items-start gap-3 rounded-2xl border border-primary-tint-border bg-primary-tint/40 p-4">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
            <Icon name="shield" size={22} />
          </span>
          <span className="min-w-0">
            <span className="block text-base font-semibold">{options.label ?? t("topup.cryptoPaySecure")}</span>
            <span className="block text-[13px] text-fg-muted">{options.description ?? t("topup.cryptoCoins")}</span>
            <span className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-success">
              <Icon name="lock" size={13} /> {t("topup.cryptoSecure")}
            </span>
          </span>
        </div>
      )}

      <fieldset>
        <legend className="mb-2.5 text-[15px] font-semibold">{t("common.amount")}</legend>
        {options.presets.length > 0 && (
          <div className="mb-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {options.presets.map((p) => {
              const selected = amount === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setAmountInput(unitsLabel(p))}
                  className={cn(
                    "h-11 rounded-lg border text-[15px] font-semibold tabular-nums transition-colors",
                    selected
                      ? "border-primary bg-primary-tint text-primary"
                      : "border-line bg-surface-muted text-fg hover:border-primary-tint-border",
                  )}
                >
                  {formatPrice(p, options.currency)}
                </button>
              );
            })}
          </div>
        )}
        <label className="block">
          <span className="sr-only">{t("topup.customAmount")}</span>
          <span className="relative block">
            <input
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              name="amount"
              aria-invalid={Boolean(invalid && amountInput) || undefined}
              aria-describedby="amount-help"
              className={cn(
                "h-12 w-full rounded-lg border bg-surface-muted pe-16 ps-4 text-lg font-semibold tabular-nums outline-none focus:border-primary",
                invalid && amountInput ? "border-danger" : "border-line",
              )}
            />
            <span className="pointer-events-none absolute top-1/2 end-4 -translate-y-1/2 text-sm font-medium text-fg-muted">
              {options.currency}
            </span>
          </span>
        </label>
        <p id="amount-help" className={cn("mt-1.5 text-[13px]", invalid && amountInput ? "text-danger" : "text-fg-muted")}>
          {invalid && amountInput
            ? invalid
            : t("topup.fromTo", { min: formatPrice(options.min, options.currency), max: formatPrice(options.max, options.currency) })}
        </p>
        <ConvertedAmount amount={invalid ? null : amount} currency={options.currency} className="mt-1" />
      </fieldset>

      {/* One provider method (Cryptomus): the coin and network are chosen on its page. */}
      <fieldset className={cn(options.methods.length < 2 && "hidden")}>
        <legend className="mb-2.5 text-[15px] font-semibold">{t("topup.method")}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {options.methods.map((m) => (
            <label
              key={m.id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors",
                method === m.id ? "border-primary bg-primary-tint/60" : "border-line hover:border-primary-tint-border",
              )}
            >
              <input type="radio" name="method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} className="sr-only" />
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-lg",
                  method === m.id ? "bg-primary text-white" : "bg-surface-muted text-fg-muted",
                )}
              >
                <Icon name={KIND_ICON[m.kind] ?? "wallet"} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{m.label}</span>
                {m.description && <span className="block text-[13px] text-fg-muted">{m.description}</span>}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border-2",
                  method === m.id ? "border-primary" : "border-line",
                )}
              >
                {method === m.id && <span className="size-2.5 rounded-full bg-primary" />}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-xl bg-surface-muted p-4 text-[15px]">
        <dt className="text-fg-muted">{t("topup.added")}</dt>
        <dd className="text-end font-medium tabular-nums">{amount !== null && !invalid ? <Money amount={amount} currency={options.currency} variant="stack" className="items-end" /> : "—"}</dd>
        <dt className="text-fg-muted">
          {t("topup.fee")}
          {hasFee && (
            <span className="text-fg-subtle">
              {" "}
              ({options.feePercent}%{options.feeFixed > 0 ? ` + ${formatPrice(options.feeFixed, options.currency)}` : ""})
            </span>
          )}
        </dt>
        <dd className="text-end tabular-nums">{quote ? (quote.fee ? formatPrice(quote.fee, options.currency) : t("topup.free")) : "—"}</dd>
        <dt className="border-t border-line pt-2 font-semibold">{t("topup.total")}</dt>
        <dd className="border-t border-line pt-2 text-end text-lg font-semibold text-primary tabular-nums">
          {quote ? <Money amount={quote.total} currency={options.currency} variant="stack" className="items-end" /> : "—"}
        </dd>
        <dt className="text-[13px] text-fg-muted">{t("topup.balanceAfter")}</dt>
        <dd className="text-end text-[13px] text-fg-muted tabular-nums">
          {amount !== null && !invalid ? <Money amount={balance + amount} currency={options.currency} variant="both" /> : "—"}
        </dd>
      </dl>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-[13px] text-fg-muted">
          {crypto ? t("topup.cryptoNote") : t("topup.gatewayNote")}
        </p>
        <Button type="submit" size="lg" loading={pending} disabled={pending || Boolean(invalid) || !method}>
          {quote ? t("topup.continueWith", { price: formatPrice(quote.total, options.currency) }) : t("topup.continue")}
        </Button>
      </div>
    </form>
  );
}
