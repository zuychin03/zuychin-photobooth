import mark from "@/lib/code-z-master.json";

interface LogoProps {
  className?: string;
  title?: string;
}

export function Logo({ className, title = "Zuychin" }: LogoProps) {
  return (
    <svg
      viewBox={mark.viewBox}
      role="img"
      aria-label={title}
      fill="currentColor"
      className={className}
    >
      <g>{mark.inkPaths.map((d) => <path key={d} d={d} />)}</g>
      <g fill="var(--accent)">{mark.accentPaths.map((d) => <path key={d} d={d} />)}</g>
    </svg>
  );
}
