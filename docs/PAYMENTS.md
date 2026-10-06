# Payments — developer notes

## Current method: manual Easypaisa / JazzCash

- Provider: `ManualPaymentProvider` (`src/server/payments/manual/manual-provider.ts`), selected by `PAYMENT_PROVIDER=manual` (default).
- Receiving account (shown on Add funds, editable in **Admin → Settings → Manual payments**):
  **Muhammad Usman — 03246623395** (Easypaisa / JazzCash), WhatsApp help **+923024966223**.
- Flow:
  1. Customer sends money to that account and submits **amount + method + transaction ID** (+ optional note) at `/profile/top-up`.
  2. `createManualTopUp()` stores a `payments` row: `provider = "manual"`, `status = PENDING`, `provider_payment_id = <transaction ID>` (unique per provider → the same transaction ID can never be claimed twice). **Nothing is credited.** Audit: `topup.created`; optional email to `ADMIN_NOTIFY_EMAIL`.
  3. An administrator checks the Easypaisa/JazzCash statement and approves or rejects in `/admin/topups`.
  4. `approveManualTopUp()` — one DB transaction: row lock → must be `PENDING` → not the admin's own request → ledger credit with the unique reference `payment:<id>:credit` → status `PAID` + reviewer + time. Audit: `topup.approved`, `wallet.credited`. Double clicks, parallel tabs and retries end with **one** credit (lock + status check + unique ledger reference).
  5. `rejectManualTopUp()` — `REJECTED` + reason + reviewer + time; never credited. Audit: `topup.rejected`. The database refuses to change a rejected (or paid) request afterwards.
- Payment proof uploads are **not** collected (no file storage in this app); verification uses the transaction ID.

## Future: Easypaisa API / JazzCash API

Do not change the wallet. Add an adapter:

1. Implement `PaymentProvider` (`src/server/payments/types.ts`) with `flow: "redirect"`:
   `createPayment` (create at the gateway, return hosted checkout URL), `getPayment` (authoritative status),
   `findPaymentByReference` (recover lost create responses), `verifyWebhook` (signature check) and, if supported, `refundPayment`.
2. Add a value to `PAYMENT_PROVIDER` in `src/server/env.ts` plus the gateway's credentials (merchant ID, API key, hash/webhook secret) as server-only env vars, and one `case` in `src/server/payments/registry.ts`.
3. Everything else already exists and is tested with a fake gateway: amount/fee validation, idempotent creation, redirect to checkout, the return page, `POST /api/payments/webhook/<provider>`, `settle()` (credits only when the gateway's own status says paid **and** amount, currency, id and reference match), mismatch → `needs_review`, and `npm run payments:reconcile`.

Never credit a wallet from a browser redirect or client message; only `settle()` (gateway) or an administrator approval (manual) may do so.

## Cryptomus (automatic crypto top-ups)

Runs **next to** the manual method; customers pick *Manual payment (Easypaisa / JazzCash)* or *Crypto payment (Cryptomus)* on `/profile/top-up`.

### Admin setup

1. Make sure the server has `SETTINGS_ENCRYPTION_KEY` (`openssl rand -base64 32`) — needed to store credentials. Keep it safe and stable: if it changes, the saved keys can't be decrypted and must be entered again.
2. Open **Admin Panel → Settings → Payments — Cryptomus**.
3. Tick **Enable Cryptomus crypto top-ups**.
4. Enter the **Merchant UUID** (Cryptomus → Business → Merchant settings).
5. Enter the **Payment API key**.
6. Optionally enter the **Payout API key** — it is only stored (separately, encrypted) for future payout features; it does **not** enable withdrawals.
7. Set display name, description, min/max, fees, sort order (Manual is 0) and invoice lifetime, then **Save**.
8. Click **Test Cryptomus Connection** (signed read-only request; creates no invoice).
9. Check the **Webhook URL** shown ("In use") is public and https; it is sent with every invoice as `url_callback`, so nothing needs to be configured in Cryptomus for it.
10. Make a small real payment and confirm it in **Admin → Payments** (provider *Cryptomus*) and **Admin → Payment webhooks**.

Credential fields are write-only: the panel shows `****************abcd`; leaving a field blank keeps the saved value; "Remove the saved …" clears it (the `CRYPTOMUS_*` env fallback then applies). Every save and connection test is audited **without** values.

Disabling hides Cryptomus from customers and stops new invoices; invoices created earlier still settle (webhooks, polling, admin re-check).

### Flow

1. `createTopUp(userId, { amount, method: "crypto", provider: "cryptomus", idempotencyKey })` validates the amount against the admin's min/max, adds the admin's fees, stores a `PENDING` `payments` row and calls `POST /v1/payment` with `order_id = payments.reference` (`TP-…`), `amount = total`, platform currency, `url_return`/`url_success` = our status page, `url_callback` = webhook URL, `lifetime`.
2. The customer pays on the hosted Cryptomus page and returns to `/profile/top-up/<id>` (the return proves nothing; the page polls our own status).
3. Cryptomus posts to `POST /api/payments/webhook/cryptomus`. `CryptomusPaymentProvider.verifyWebhook` checks the signature — `md5(base64(json_encode(payload without sign, JSON_UNESCAPED_UNICODE)) + PAYMENT_API_KEY)`, compared in constant time — and optionally the source IP `91.227.144.54` (only with `TRUST_PROXY=true`). Bad signature → 401 + `system_logs` `webhook_rejected`; nothing is stored or credited.
4. The webhook is only a hint: the invoice is re-read with `POST /v1/payment/info` and `settle()` applies that answer.

Status mapping (`src/server/payments/cryptomus/provider.ts`): `paid`, `paid_over` → credit; `wrong_amount` → `UNDERPAID` (never credited, needs review); `check` → pending; `process`, `confirm_check`, `wrong_amount_waiting`, `locked` → processing; `fail`, `system_fail` → `FAILED`; `cancel` → `CANCELLED`; `refund_paid` → `REFUNDED` (+ review); `refund_process`, `refund_fail` → no change. `paid_over` credits the chosen amount and flags the payment for review (`OVERPAID`).

### Idempotency and races

- Invoice creation: per-user `idempotency_key` (unique) + Cryptomus' unique `order_id`.
- Webhook events: `payment_events` unique `(provider, event_id)` with `event_id = <uuid>:<status>`; `processed_at` marks done; `result` / `error` record the outcome.
- Credit: `settle()` locks the payment row (`SELECT … FOR UPDATE`), credits only from `PENDING/PROCESSING/closed-unpaid` with matching amount, currency, invoice UUID and order ID, and writes the ledger with the unique reference `payment:<id>:credit`. A DB trigger keeps amounts and `PAID` final. Duplicate, resent and concurrent webhooks therefore credit exactly once (tested).
- Unreachable Cryptomus while confirming → 503 so Cryptomus redelivers; `npm run payments:reconcile` also polls open invoices.

### Admin tools

- **Admin → Payments**: filter by provider / method / status (incl. *underpaid*, *rejected*) / date; search by order ID, payment ID, Cryptomus UUID or email.
- **Payment detail**: invoice UUID, order ID, amounts, fee, dates, Cryptomus details (coin, network, TXID, paid amount, commission, provider status), invoice-creation errors, ledger, webhook events; **Re-check with provider**; **Request webhook resend** (`POST /v2/payment/resend`, for paid / underpaid invoices — the resent webhook is de-duplicated).
- **Admin → Payment webhooks**: every verified webhook with its result; filter "Unprocessed / errors".

### Code map

| Piece | File |
| --- | --- |
| Provider registry (manual + Cryptomus) | `src/server/payments/registry.ts` |
| Cryptomus provider / client / signature / config | `src/server/payments/cryptomus/*` |
| Encrypted settings (AES-256-GCM) | `src/server/security/secrets.ts`, setting `payment_cryptomus` |
| Admin settings + test connection | `src/server/admin/payment-settings.ts`, `src/components/admin/CryptomusSettingsForm.tsx` |
| Top-up chooser | `src/components/payments/TopUpMethodChooser.tsx`, `TopUpForm.tsx` |
| Tests (local stand-in of the documented API) | `tests/cryptomus.test.ts` |

Database (`prisma/migrations/20261006090000_cryptomus`): `PaymentStatus` + `UNDERPAID`; `payment_events.result`, `payment_events.error`, index `(provider, created_at)`. No new wallet tables.

API: `GET /api/payments/options` now also returns `providers[]`; `POST /api/payments` accepts an optional `provider` (`"cryptomus"`) with `method: "crypto"`.

Environment: `SETTINGS_ENCRYPTION_KEY`, `CRYPTOMUS_MERCHANT_ID`, `CRYPTOMUS_PAYMENT_API_KEY`, `CRYPTOMUS_PAYOUT_API_KEY`, `CRYPTOMUS_WEBHOOK_URL`, `CRYPTOMUS_API_URL` (see `.env.example`). Admin-saved values win.

### Security model

Credentials exist in plain form only inside the server process (outgoing requests). They are never sent to the browser, logged, audited or put in error messages; the admin UI receives masks only. Only administrators (server-side admin session check + rate limit) can change them. The Payment key is used for invoices and webhook verification only; the Payout key is never used for payments.

### Deployment

1. Set `SETTINGS_ENCRYPTION_KEY` (and `TRUST_PROXY=true` behind a reverse proxy if you enable the IP check).
2. Back up the database, then `npx prisma migrate deploy`.
3. Deploy, configure Cryptomus in the admin panel, test the connection, make a small real payment.
