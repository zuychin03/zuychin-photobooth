---
kind: frontend_style
name: Tailwind CSS v4 + CSS Variables Design System
category: frontend_style
scope:
    - '**'
source_files:
    - app/globals.css
    - postcss.config.mjs
    - package.json
    - app/layout.tsx
---

The application uses Tailwind CSS v4 (via `@tailwindcss/postcss`) as its primary styling system, combined with a CSS custom properties–based design token layer defined in `app/globals.css`. There is no separate `tailwind.config.*` file; configuration is handled through the PostCSS plugin and inline `@theme` directives.

**Design tokens and theming**
- Semantic color tokens are declared on `:root` and `.light`, with a parallel `.dark` palette. Tokens include `--background`, `--foreground`, `--card`, `--muted`, `--accent` (rose), `--partner` (purple, for duo-room UI differentiation), `--border`, `--ring`, `--destructive`, `--success`, `--warning`, `--info`, and `--datestamp`.
- The `@theme inline { ... }` block maps these CSS variables into Tailwind's theme namespace (`--color-*`, `--font-*`), making them available as utility classes like `bg-background`, `text-muted-foreground`, `border-border`, etc.
- Dark mode is supported both via an explicit `.dark` class and automatically through `@media (prefers-color-scheme: dark)`.
- Fonts are injected via Next.js `next/font/google`: Geist Sans/Mono, Fraunces (display), and Noto Emoji, each exposed as CSS variables (`--font-geist-sans`, `--font-geist-mono`, `--font-fraunces`, `--font-noto-emoji`).

**Layout and responsive strategy**
- Layouts use Tailwind's flexbox/grid utilities with mobile-first breakpoints (`sm:`, `md:`, `lg:`). Pages like `booth/page.tsx` and `customize/page.tsx` switch from column to row layouts at `md:` breakpoints.
- A dedicated `.booth-mode` class overrides theme tokens to force near-black backgrounds during capture/room screens so the camera feed remains the visual focus.

**Reusable style primitives**
- `.glass-card` provides a glassmorphism effect using `backdrop-filter: blur(24px)` and semi-transparent borders built from `color-mix()` against the current card/border tokens.
- Animation keyframes define fluid background orbs (`fluid-drift`, `fluid-drift-slow`), hero text reveals (`fade-up`), countdown pulses, capture flashes, and strip-print transitions. Utility classes like `.hero-animate-delay-{1..4}` provide staggered delays.
- Accessibility is considered: `@media (prefers-reduced-motion: reduce)` disables animations and collapses durations to near-zero.
- Scrollbars are globally styled with a thin muted thumb, and a `.scrollbar-hide` utility hides scrollbars when needed.

**Component styling conventions**
- Components compose Tailwind utility classes directly in JSX `className` props rather than defining per-component CSS modules or SCSS files. Examples include `rounded-full`, `bg-accent`, `text-accent-foreground`, `shadow-lg`, `glass-card`, and `p-4 sm:p-6 md:max-w-4xl` patterns throughout pages and components.
- Iconography comes from `lucide-react`, used alongside Tailwind spacing and sizing utilities.
- No SCSS/SASS or CSS-in-JS libraries are present; styling is purely Tailwind utilities plus the global CSS file.