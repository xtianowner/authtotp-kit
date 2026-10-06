import { motion, useReducedMotion } from 'motion/react'
import { ArrowRight, BookOpen } from 'lucide-react'
import BlurText from '../components/reactbits/BlurText.jsx'
import ShinyText from '../components/reactbits/ShinyText.jsx'
import Magnet from '../components/reactbits/Magnet.jsx'
import SpotlightCard from '../components/reactbits/SpotlightCard.jsx'
import { useLocale } from '../i18n/LocaleProvider.jsx'

// 示例区块：演示 token 语义 class + react-bits 组件 + i18n + 响应式 + reduced-motion。
export default function Hero() {
  const { t } = useLocale()
  const reduce = useReducedMotion()

  return (
    <section className="relative isolate mx-auto flex min-h-[80vh] w-full max-w-6xl flex-col items-center justify-center gap-6 overflow-hidden px-5 py-20 text-center">
      <motion.span
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="rounded-full border border-border bg-surface px-4 py-1 text-sm text-muted"
      >
        <ShinyText text={t('hero.tagline')} speed={3} color="var(--text-muted)" shineColor="var(--text)" />
      </motion.span>

      <BlurText
        text={t('hero.title')}
        className="font-heading text-4xl font-semibold leading-tight text-text sm:text-5xl md:text-6xl"
        animateBy="words"
      />

      <p className="max-w-xl text-base leading-relaxed text-muted sm:text-lg">
        {t('hero.subtitle')}
      </p>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-4">
        <Magnet padding={80} magnetStrength={3}>
          <button className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-gradient px-6 py-3 font-semibold text-on-bright shadow-glow transition-transform duration-base ease-out hover:scale-[1.02]">
            {t('hero.cta')} <ArrowRight size={18} />
          </button>
        </Magnet>
        <button className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border bg-surface px-6 py-3 font-medium text-text transition-colors duration-base hover:border-accent">
          <BookOpen size={18} /> {t('hero.docs')}
        </button>
      </div>

      <SpotlightCard className="mt-10 max-w-md text-left" spotlightColor="color-mix(in srgb, var(--accent) 25%, transparent)">
        <p className="text-sm text-muted">
          Tokens · Motion · react-bits — <span className="text-text">one contract</span>.
        </p>
      </SpotlightCard>
    </section>
  )
}
