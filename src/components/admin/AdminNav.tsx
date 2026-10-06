"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/icons";
import { cn } from "@/lib/cn";

const ITEMS: { href: string; label: string; icon: IconName }[] = [
  { href: "/admin", label: "Dashboard", icon: "chart" },
  { href: "/admin/users", label: "Users", icon: "user" },
  { href: "/admin/wallets", label: "Wallets", icon: "wallet" },
  { href: "/admin/topups", label: "Top-ups", icon: "plus" },
  { href: "/admin/payments", label: "Payments", icon: "lock" },
  { href: "/admin/payment-events", label: "Payment webhooks", icon: "refresh" },
  { href: "/admin/orders", label: "Orders", icon: "phone" },
  { href: "/admin/transactions", label: "Transactions", icon: "history" },
  { href: "/admin/countries", label: "Countries", icon: "globe" },
  { href: "/admin/services", label: "Services", icon: "grid" },
  { href: "/admin/ready-made-accounts", label: "Ready Made Accounts", icon: "box" },
  { href: "/admin/providers", label: "Providers", icon: "cpu" },
  { href: "/admin/pricing", label: "Pricing", icon: "trendingUp" },
  { href: "/admin/custom-margins", label: "Custom Margins", icon: "zap" },
  { href: "/admin/blog", label: "Blog", icon: "article" },
  { href: "/admin/audit-logs", label: "Audit logs", icon: "shield" },
  { href: "/admin/logs", label: "System logs", icon: "alert" },
  { href: "/admin/settings", label: "Settings", icon: "settings" },
];

/** Vertical nav on desktop; a horizontally scrollable strip on small screens. */
export function AdminNav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname.startsWith(href));
  return (
    <nav aria-label="Admin" className="-mx-3 overflow-x-auto px-3 sm:-mx-6 sm:px-6 lg:mx-0 lg:overflow-visible lg:px-0">
      <ul className="flex gap-1 lg:flex-col">
        {ITEMS.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={active(i.href) ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                active(i.href) ? "bg-primary text-white" : "text-fg-muted hover:bg-surface-muted hover:text-fg",
              )}
            >
              <Icon name={i.icon} size={17} />
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
