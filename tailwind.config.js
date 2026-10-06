/** Tailwind v3.4 — every value maps to a design token in src/styles/tokens.css (作者视觉基线：博客青绿与暗色 HUD).
 *  Colour keys mirror the token names: bg-bg / bg-elev / bg-tint / text-heading / text-text / text-muted /
 *  border-border / bg-accent / text-accent-ink …, all `rgba(var(--token), <alpha-value>)` so `/10` opacity works.
 *  Comma form on purpose: the tokens are comma triplets (`13, 148, 136`), and `rgb(13, 148, 136 / 0.1)` is invalid CSS.
 *  Don't add raw hex/px utilities ad hoc. */
/** @type {import('tailwindcss').Config} */
const token = (name) => `rgba(var(--${name}), <alpha-value>)`

export default {
  content: ['./index.html', './public-tool.html', './src/**/*.{js,jsx,ts,tsx}', '!./src/lab/**'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        elev: token('bg-elev'),
        tint: token('bg-tint'),
        heading: token('heading'),
        text: token('text'),
        muted: token('muted'),
        border: token('border'),
        accent: { DEFAULT: token('accent'), strong: token('accent-strong'), ink: token('accent-ink'), fill: token('accent-fill') },
        'on-accent': token('on-accent'),
        success: token('success'),
        warning: token('warning'),
        danger: token('danger'),
        'on-danger': token('on-danger'),
        mint: token('pastel-mint'),
      },
      // Preflight defaults (bare `border`, `ring`, placeholders) also stay on-token instead of Tailwind's grays/blues.
      borderColor: { DEFAULT: token('border') },
      ringColor: { DEFAULT: ({ opacityValue }) => `rgba(var(--accent), ${opacityValue ?? 1})` },
      borderRadius: {
        sm: 'var(--radius-field)',
        DEFAULT: 'var(--radius-field)',
        md: 'var(--radius-field)',
        lg: 'var(--radius-card)',
        xl: 'var(--radius-card)',
        '2xl': 'var(--radius-card)',
        card: 'var(--radius-card)',
        field: 'var(--radius-field)',
        full: 'var(--radius-pill)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      boxShadow: {
        DEFAULT: 'var(--shadow)',
        sm: 'var(--shadow)',
        card: 'var(--shadow)',
        lift: 'var(--shadow-lift)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)',
        brand: 'var(--ease)',
      },
      transitionDuration: {
        DEFAULT: 'var(--dur-fast)',
        fast: 'var(--dur-fast)',
        base: 'var(--dur)',
      },
      zIndex: {
        dropdown: '10', sticky: '20', overlay: '30', modal: '40', toast: '50',
      },
    },
  },
  plugins: [],
}
