import type { ReactNode, Ref } from "react";

interface Props {
  title: ReactNode;
  actions?: ReactNode;
  /** One short line of state (counts, scope), never a description of the page. */
  meta?: ReactNode;
  leading?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
}

export function PageHeader({ title, actions, meta, leading, headingRef, className = "" }: Props) {
  return <header className={`page-head flex flex-wrap items-end justify-between gap-x-8 gap-y-4 ${className}`}>
    <div className="min-w-0 max-w-full">
      {leading && <div className="mb-3">{leading}</div>}
      <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="font-display text-[2.125rem] leading-[1.12] outline-none sm:text-5xl">{title}</h1>
      {meta && <div className="mt-2 text-sm text-muted-foreground">{meta}</div>}
    </div>
    {actions && <div className="flex max-w-full flex-wrap gap-2">{actions}</div>}
  </header>;
}
