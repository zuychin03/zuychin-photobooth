import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// Fixed hues so the white glyph keeps its contrast in both themes.
const tones = {
  rose: "bg-[#f43f5e]",
  violet: "bg-[#8b5cf6]",
  amber: "bg-[#f59e0b]",
  sky: "bg-[#0ea5e9]",
  green: "bg-[#10b981]",
  slate: "bg-[#64748b]",
} as const;
export type SectionTone = keyof typeof tones;

interface Props {
  id: string;
  title: ReactNode;
  icon?: LucideIcon;
  tone?: SectionTone;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function Section({ id, title, icon: Icon, tone = "rose", action, children, className = "", bodyClassName = "mt-4" }: Props) {
  return <section aria-labelledby={id} className={`panel p-4 sm:p-6 ${className}`}>
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <span className={`glyph ${tones[tone]}`}><Icon size={18} strokeWidth={2.25} aria-hidden /></span>}
        <h2 id={id} className="font-display text-xl leading-tight">{title}</h2>
      </div>
      {action}
    </div>
    {children && <div className={bodyClassName}>{children}</div>}
  </section>;
}
