-- Cryptomus crypto top-ups.
-- New final status for invoices paid with less than the required amount
-- (never credited automatically). Appending an ENUM value doesn't touch rows.
ALTER TABLE `payments`
    MODIFY `status` ENUM('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'REJECTED', 'UNDERPAID') NOT NULL DEFAULT 'PENDING';

-- Webhook processing log: outcome and a safe reason (never payloads or secrets).
ALTER TABLE `payment_events`
    ADD COLUMN `result` VARCHAR(32) NULL,
    ADD COLUMN `error` VARCHAR(255) NULL;

CREATE INDEX `payment_events_provider_created_at_idx` ON `payment_events`(`provider`, `created_at`);
