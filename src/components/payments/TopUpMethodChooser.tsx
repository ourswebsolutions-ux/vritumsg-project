"use client";

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n/client";

export type TopUpChoice = {
  id: string;
  icon: IconName;
  title: string;
  subtitle: string;
  description: string;
  badge: string;
  badgeTone: "primary" | "accent";
  panel: ReactNode;
};

/** Manual vs crypto: two selectable cards, then the chosen method's form. */
export function TopUpMethodChooser({ choices, initial }: { choices: TopUpChoice[]; initial?: string }) {
  const t = useT();
  const [selected, setSelected] = useState(() => choices.find((c) => c.id === initial)?.id ?? choices[0]?.id);
  const current = choices.find((c) => c.id === selected) ?? choices[0];

  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="mb-3 text-[15px] font-semibold">{t("topup.chooseMethod")}</legend>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {choices.map((c) => {
            const on = c.id === current?.id;
            return (
              <label
                key={c.id}
                className={cn(
                  "relative flex cursor-pointer gap-3.5 rounded-2xl border p-4 transition-all has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                  on ? "border-primary bg-primary-tint/50 shadow-sm" : "border-line hover:border-primary-tint-border hover:bg-surface-muted/60",
                )}
              >
                <input type="radio" name="topup-method" value={c.id} checked={on} onChange={() => setSelected(c.id)} className="sr-only" />
                <span
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center rounded-xl transition-colors",
                    on ? "bg-primary text-white" : "bg-surface-muted text-fg-muted",
                  )}
                >
                  <Icon name={c.icon} size={24} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-base font-semibold">{c.title}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                        c.badgeTone === "primary" ? "bg-success-tint text-success" : "bg-accent-tint text-accent",
                      )}
                    >
                      {c.badge}
                    </span>
                  </span>
                  <span className="block text-[13px] font-medium text-fg-muted">{c.subtitle}</span>
                  <span className="mt-1.5 block text-[13px] leading-relaxed text-fg-muted">{c.description}</span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn("mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border-2", on ? "border-primary" : "border-line")}
                >
                  {on && <span className="size-2.5 rounded-full bg-primary" />}
                </span>
                {on && <span className="sr-only">{t("topup.selected")}</span>}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div key={current?.id}>{current?.panel}</div>
    </div>
  );
}
