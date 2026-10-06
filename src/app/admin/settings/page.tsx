import type { Metadata } from "next";
import { CurrencyMarkupForm, MaintenanceForm, ManualPaymentForm } from "@/components/admin/AdminForms";
import { KeyValues } from "@/components/admin/AdminParts";
import { SettingsSection } from "@/components/profile/SettingsForms";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { siteConfig } from "@/config/site";
import { CryptomusSettingsForm } from "@/components/admin/CryptomusSettingsForm";
import {
  adminSaveCryptomusAction,
  adminSaveCurrencyMarkupAction,
  adminSaveMaintenanceAction,
  adminSaveManualPaymentAction,
  adminTestCryptomusAction,
} from "@/server/actions/admin";
import { getCryptomusSettings } from "@/server/admin/payment-settings";
import { requireAdminPage } from "@/server/admin/guard";
import { getPlatformSettings } from "@/server/admin/platform";

export const metadata: Metadata = { title: "Settings" };

/** Only settings with real behaviour. Credentials are write-only here (masked, stored encrypted). */
export default async function AdminSettingsPage() {
  await requireAdminPage("/admin/settings");
  const [s, cryptomus] = await Promise.all([getPlatformSettings(), getCryptomusSettings()]);

  return (
    <Card>
      <PageHeader title="Platform settings" />
      <SettingsSection id="maintenance" title="Maintenance mode" description="Pauses number purchases and top-ups for everyone and shows a banner. Browsing, login and this admin panel keep working.">
        <MaintenanceForm action={adminSaveMaintenanceAction} enabled={s.maintenance.enabled} message={s.maintenance.message} />
      </SettingsSection>
      <SettingsSection
        id="manual-payment"
        title="Manual payments"
        description="The Easypaisa / JazzCash account customers send money to, and the WhatsApp number for help. Shown on Add funds."
      >
        <ManualPaymentForm
          action={adminSaveManualPaymentAction}
          accountName={s.manual.accountName}
          accountNumber={s.manual.accountNumber}
          whatsapp={s.manual.whatsapp}
          note={s.manual.note}
        />
      </SettingsSection>
      <SettingsSection
        id="payments-cryptomus"
        title="Payments — Cryptomus (crypto)"
        description="Automatic crypto top-ups next to manual Easypaisa / JazzCash. Balances are credited only from a signature-verified Cryptomus webhook, confirmed with the Cryptomus API."
      >
        <CryptomusSettingsForm save={adminSaveCryptomusAction} test={adminTestCryptomusAction} s={cryptomus} />
      </SettingsSection>
      <SettingsSection
        id="currency-conversion"
        title="Currency conversion — Conversion Tax / Markup"
        description="Added to the exchange rate for each display currency (1 USD = base rate + tax), then used for every converted price customers see. It is not added to product prices, and all charges stay in USD."
      >
        <CurrencyMarkupForm action={adminSaveCurrencyMarkupAction} rates={s.displayRates} markup={s.currencyMarkup} />
      </SettingsSection>
      <SettingsSection id="environment" title="Configuration" description="Set in the server environment (read-only here). Credentials are never shown.">
        <KeyValues
          rows={[
            ["Platform name", siteConfig.name],
            ["Currency", s.info.currency],
            ["Site URL", s.info.appUrl],
            ["SMS provider", s.info.smsProvider],
            ["Payment providers", s.info.paymentProvider === "manual" ? `manual${cryptomus.active ? " + cryptomus" : ""}` : cryptomus.active ? "cryptomus" : "none"],
            ["Email", s.info.email],
          ]}
        />
      </SettingsSection>
    </Card>
  );
}
