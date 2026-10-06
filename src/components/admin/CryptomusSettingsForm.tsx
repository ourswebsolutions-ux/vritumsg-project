"use client";

import { startTransition, useRef, useState } from "react";
import { FormMessage } from "@/components/forms/FormParts";
import { useFormAction } from "@/components/forms/useFormAction";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/Input";
import { useResultToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/format";
import type { CryptomusSettingsView } from "@/server/admin/payment-settings";
import type { FormState } from "@/types/forms";

type Action = (prev: FormState, data: FormData) => Promise<FormState>;
type SecretName = "merchantId" | "paymentKey" | "payoutKey";

/**
 * Admin → Settings → Payments → Cryptomus. Credentials are write-only: the
 * page only ever receives a masked hint ("****************abcd"), and a
 * blank field keeps the saved value.
 */
export function CryptomusSettingsForm({ save, test, s }: { save: Action; test: Action; s: CryptomusSettingsView }) {
  const [saveState, runSave] = useFormAction(save);
  const [testState, runTest] = useFormAction(test);
  useResultToast(saveState);
  useResultToast(testState);
  const formRef = useRef<HTMLFormElement>(null);
  const [testing, setTesting] = useState(false);

  const status = s.decryptError
    ? { tone: "danger" as const, text: "Credentials can't be decrypted" }
    : s.active
      ? { tone: "success" as const, text: "Enabled · live" }
      : s.configured
        ? { tone: "warning" as const, text: "Configured · disabled" }
        : { tone: "neutral" as const, text: "Not configured" };

  function secretField(name: SecretName, label: string, hint: string, required?: boolean) {
    const masked = s.masked[name];
    const source = s.sources[name];
    return (
      <div className="space-y-1.5">
        <Field
          label={label}
          required={required}
          hint={
            masked ? (
              <>
                Saved: <span className="font-mono">{masked}</span> {source === "env" ? "(from environment variable)" : "(encrypted in database)"} — leave blank to keep it.{" "}
                {hint}
              </>
            ) : (
              <>Not set. {hint}</>
            )
          }
        >
          {(p) => (
            <Input
              {...p}
              name={name}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={masked ?? (name === "merchantId" ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" : "Paste the key")}
              maxLength={600}
              className="font-mono"
            />
          )}
        </Field>
        {masked && source === "admin" && <Checkbox name={`${name}Clear`} label={`Remove the saved ${label.toLowerCase()}`} className="text-[13px]" />}
      </div>
    );
  }

  return (
    <form ref={formRef} action={runSave} className="space-y-5" autoComplete="off">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-muted p-3 text-sm">
        <span className="font-medium">Status</span>
        <Badge tone={status.tone}>{status.text}</Badge>
        {s.lastTest && (
          <span className="text-fg-muted">
            · Last test {s.lastTest.ok ? "passed" : "failed"} {formatDateTime(s.lastTest.at)}
            {s.lastTest.ok && s.lastTest.services ? ` (${s.lastTest.services} payment options)` : ""}
          </span>
        )}
      </div>

      {s.decryptError && (
        <Alert tone="error" title="Saved credentials can't be decrypted">
          SETTINGS_ENCRYPTION_KEY is missing or was changed since they were saved. Enter the credentials again (or restore the key). Crypto top-ups stay
          unavailable until then.
        </Alert>
      )}
      {!s.canEncrypt && (
        <Alert tone="warning" title="Encryption key not set">
          Set <code>SETTINGS_ENCRYPTION_KEY</code> on the server (e.g. <code>openssl rand -base64 32</code>) to save credentials here. Until then only the
          CRYPTOMUS_* environment variables can be used.
        </Alert>
      )}

      <Checkbox name="enabled" label="Enable Cryptomus crypto top-ups for customers" defaultChecked={s.enabled} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {secretField("merchantId", "Merchant UUID", "Cryptomus → Business → Merchant settings.", true)}
        {secretField("paymentKey", "Payment API key", "Used to create invoices and verify webhooks.", true)}
        {secretField("payoutKey", "Payout API key", "Optional. Stored separately; withdrawals are NOT enabled by it.")}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          loading={testing}
          onClick={() => {
            if (!formRef.current) return;
            const data = new FormData(formRef.current);
            setTesting(true);
            startTransition(async () => {
              await runTest(data);
              setTesting(false);
            });
          }}
        >
          Test Cryptomus Connection
        </Button>
        <p className="max-w-md text-xs text-fg-muted">Sends a signed read-only request with the typed values (or the saved ones when blank). No invoice is created.</p>
      </div>
      <FormMessage state={testState} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Display name" required hint="Shown to customers on Add funds.">
          {(p) => <Input {...p} name="displayName" defaultValue={s.displayName} maxLength={60} />}
        </Field>
        <Field label="Sort order" hint="Lower comes first; Manual payment is 0.">
          {(p) => <Input {...p} name="sortOrder" inputMode="numeric" defaultValue={String(s.sortOrder)} maxLength={3} />}
        </Field>
      </div>
      <Field label="Description" hint="Optional, up to 200 characters. Leave the default for translated wording.">
        {(p) => <Textarea {...p} name="description" rows={2} maxLength={200} defaultValue={s.description} />}
      </Field>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Field label={`Minimum (${s.currency})`} required>
          {(p) => <Input {...p} name="minAmount" inputMode="decimal" defaultValue={s.minAmount} maxLength={12} />}
        </Field>
        <Field label={`Maximum (${s.currency})`} required>
          {(p) => <Input {...p} name="maxAmount" inputMode="decimal" defaultValue={s.maxAmount} maxLength={12} />}
        </Field>
        <Field label={`Fixed fee (${s.currency})`}>
          {(p) => <Input {...p} name="feeFixed" inputMode="decimal" defaultValue={s.feeFixed} maxLength={12} />}
        </Field>
        <Field label="Percentage fee (%)">
          {(p) => <Input {...p} name="feePercent" inputMode="decimal" defaultValue={s.feePercent} maxLength={6} />}
        </Field>
        <Field label="Invoice lifetime (min)" hint="5–720">
          {(p) => <Input {...p} name="lifetimeMinutes" inputMode="numeric" defaultValue={String(s.lifetimeMinutes)} maxLength={3} />}
        </Field>
      </div>
      <p className="-mt-2 text-xs text-fg-muted">
        Invoice currency: <b>{s.currency}</b> (the platform currency). Fees are added on top; the customer&apos;s balance is credited with the amount they chose.
      </p>

      <div className="space-y-1.5">
        <Field label="Webhook URL" hint="Leave empty to use the default below. Must be publicly reachable over https.">
          {(p) => <Input {...p} name="webhookUrl" type="url" defaultValue={s.webhookUrl ?? ""} placeholder={s.defaultWebhookUrl} maxLength={255} />}
        </Field>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
          In use: <span className="font-mono break-all text-fg">{s.effectiveWebhookUrl}</span>
          <CopyButton value={s.effectiveWebhookUrl} label="Copy webhook URL" className="size-7" />
        </p>
      </div>

      <div className="space-y-1">
        <Checkbox name="verifyIp" label="Also require webhooks to come from Cryptomus' IP (91.227.144.54)" defaultChecked={s.verifyIp} />
        <p className="ms-7 text-xs text-fg-muted">
          The signature is always verified. {s.trustProxy ? "TRUST_PROXY is on, so the client IP is read from the proxy headers." : "TRUST_PROXY is off: the IP check is skipped until it is enabled behind your reverse proxy."}
        </p>
      </div>

      <FormMessage state={saveState} />
      <Button type="submit">Save Cryptomus settings</Button>
    </form>
  );
}
