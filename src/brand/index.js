// Brand package config — the ONLY module that references src/brand/xtian/. Display-layer pages (public home,
// vault login, 404) read their figure images and the footer signature from here; nothing else hard-codes a brand
// path. Every page renders without a figure (null) and the footer without a signature (null).
import homeFigureSrc from './xtian/fig-authtotp-dark-b.webp'
import loginFigureSrc from './xtian/fig-totp-door-dark.webp'
import notFoundFigureSrc from './xtian/fig-totp-sleep-dark.webp'

// A deployment's own choice lives in src/brand/local/index.js, which git ignores so updates never touch it
// (AGENTS.md §7 writes it). Each of the four exports it defines replaces the default below; null removes it.
const local = Object.values(import.meta.glob('./local/index.js', { eager: true }))[0] ?? {}
const pick = (name, fallback) => (name in local ? local[name] : fallback)

// Named exports (not one object) so a build only emits the figures its pages use — the public build ships the
// home figure alone.

// Footer signature line (炫技指导 §2.7). label is per locale.
export const attribution = /* @__PURE__ */ pick('attribution', {
  href: 'https://blog.xtianowner.com/',
  label: { zh: 'by XTian', en: 'by XTian' },
})

// Public home, screen 2: holding a shield and a key (dark studio, teal rim light).
export const homeFigure = /* @__PURE__ */ pick('homeFigure', { src: homeFigureSrc, width: 587, height: 900 })

// Vault login: pushing open a glowing vault door.
export const loginFigure = /* @__PURE__ */ pick('loginFigure', { src: loginFigureSrc, width: 816, height: 900 })

// 404: dozing against a small safe. `bubble` animates the snot bubble already drawn in this image: a copy of that
// region (box, natural px) is clipped to `outline` (% of the box) and scaled around `anchor` (% of the box, the
// nostril). Image-specific — a replacement illustration sets bubble to null.
export const notFoundFigure = /* @__PURE__ */ pick('notFoundFigure', {
  src: notFoundFigureSrc,
  width: 615,
  height: 900,
  bubble: {
    box: [99, 296, 80, 54],
    anchor: [95, 55.6],
    outline: '33% 2.8%, 41.9% 5.6%, 50.6% 11.1%, 58.1% 16.7%, 64.4% 22.2%, 69.4% 27.8%, 71.9% 33.3%, 79.4% 38.9%, 85.6% 44.4%, 93.1% 50%, 97% 55.6%, 93.1% 61.1%, 81.9% 66.7%, 79.4% 72.2%, 69.4% 77.8%, 63.1% 83.3%, 51.9% 88.9%, 36.9% 94.4%, 30.6% 97.2%, 24.4% 94.4%, 20.6% 88.9%, 14.4% 83.3%, 10.6% 77.8%, 8.1% 72.2%, 5.6% 66.7%, 4.4% 61.1%, 3.1% 55.6%, 1.9% 50%, 1.9% 44.4%, 3.1% 38.9%, 3.1% 33.3%, 5.6% 27.8%, 4.4% 22.2%, 10.6% 16.7%, 15.6% 11.1%, 24.4% 5.6%',
  },
})

/** Footer signature for the current locale. */
export function attributionLabel(locale) {
  return attribution ? attribution.label[locale] || attribution.label.zh : ''
}
