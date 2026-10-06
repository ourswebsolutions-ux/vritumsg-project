import type { Metadata, Viewport } from "next";
import {
  Manrope,
  Noto_Naskh_Arabic,
  Noto_Sans_Bengali,
  Noto_Sans_Devanagari,
} from "next/font/google";
import "flag-icons/css/flag-icons.min.css";
import "./globals.css";
import LiveChatWidget from "@/components/LiveChatWidget";
import { DisplayCurrencyProvider } from "@/components/currency/DisplayCurrency";
import { Footer } from "@/components/layout/Footer";
import { Header } from "@/components/layout/Header";
import { MaintenanceBanner } from "@/components/layout/MaintenanceBanner";
import { siteConfig } from "@/config/site";
import { I18nProvider } from "@/i18n/client";
import { dirOf } from "@/i18n/config";
import { getLocale, getMessages, getT } from "@/i18n/server";
import { themeInitScript } from "@/lib/theme-script";
import { getDisplayRates } from "@/server/services/exchange-rates";
import { isChatbotActive } from "@/server/services/chatbot-subscription";

const manrope = Manrope({
  subsets: ["latin", "latin-ext"],
  variable: "--font-manrope",
  display: "swap",
});
// Scripts Manrope doesn't cover. Browsers download a font only when text in that script is shown.
const naskh = Noto_Naskh_Arabic({
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap",
  preload: false,
});
const devanagari = Noto_Sans_Devanagari({
  subsets: ["devanagari"],
  variable: "--font-devanagari",
  display: "swap",
  preload: false,
});
const bengali = Noto_Sans_Bengali({
  subsets: ["bengali"],
  variable: "--font-bengali",
  display: "swap",
  preload: false,
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: {
      default: t("site.title", { name: siteConfig.name }),
      template: `%s | ${siteConfig.name}`,
    },
    description: t("site.description"),
  };
}

export const viewport: Viewport = {
  themeColor: "#0f3b6a",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Display-only exchange rates for the currency selector (cached; never used for charging).
  const [rates, locale, messages, t, chatbotActive] = await Promise.all([
    getDisplayRates(),
    getLocale(),
    getMessages(),
    getT(),
    // The global chatbot subscription is checked on the server for every page; when inactive the widget isn't sent at all.
    isChatbotActive().catch(() => false),
  ]);
  return (
    // data-theme is set by themeInitScript before hydration.
    <html
      lang={locale}
      dir={dirOf(locale)}
      className={`${manrope.variable} ${naskh.variable} ${devanagari.variable} ${bengali.variable}`}
      suppressHydrationWarning
    >
      <head>
          <meta name="cryptomus" content="4ee61891" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <I18nProvider locale={locale} messages={messages}>
          <DisplayCurrencyProvider rates={rates}>
            <a
              href="#main"
              className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-2 focus:start-2"
            >
              {t("common.skipToContent")}
            </a>
            <Header />
            <MaintenanceBanner />
            <div id="main" className="flex-1">
              {children}
            </div>
            <Footer />
            {chatbotActive && <LiveChatWidget />}
          </DisplayCurrencyProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
