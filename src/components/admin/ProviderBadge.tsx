import { Badge } from "@/components/ui/Badge";

const METHOD: Record<string, string> = { easypaisa: "Easypaisa", jazzcash: "JazzCash", crypto: "Crypto" };

/** Payment provider + method, e.g. "Cryptomus · Crypto" or "Manual · JazzCash". */
export function ProviderBadge({ provider, method }: { provider: string; method: string }) {
  const name = provider === "cryptomus" ? "Cryptomus" : provider === "manual" ? "Manual" : provider;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Badge tone={provider === "cryptomus" ? "soft" : "neutral"}>{name}</Badge>
      <span className="text-fg-muted">{METHOD[method] ?? method}</span>
    </span>
  );
}
