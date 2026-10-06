import { Home, LockKeyhole } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider.jsx'
import { HudBackdrop, HudFrame, ShowcaseFooter, ShowcaseTop } from '../showcase/chrome.jsx'
import { notFoundFigure } from '../brand/index.js'
import '../showcase/showcase.css'

// 404 (display layer, dark showcase — 视觉基线 v1.4 §14). The dozing figure is alive but restrained: the
// whole figure rises and falls with a slow breath, the snot bubble drawn in the image inflates on each out-breath
// (a clipped copy of that region scaled around the nostril — notFoundFigure.bubble in src/brand/index.js), and
// small z's drift up. transform / opacity only; all of it stops under reduced motion (showcase.css).
function Sleeper({ figure }) {
  const { src, width, height, bubble } = figure
  let bubbleStyle = null
  if (bubble) {
    const [bx, by, bw, bh] = bubble.box
    bubbleStyle = {
      left: `${(bx / width) * 100}%`,
      top: `${(by / height) * 100}%`,
      width: `${(bw / width) * 100}%`,
      height: `${(bh / height) * 100}%`,
      backgroundImage: `url(${src})`,
      backgroundSize: `${(width / bw) * 100}% ${(height / bh) * 100}%`,
      backgroundPosition: `${(bx / (width - bw)) * 100}% ${(by / (height - bh)) * 100}%`,
      clipPath: `polygon(${bubble.outline})`,
      transformOrigin: `${bubble.anchor[0]}% ${bubble.anchor[1]}%`,
    }
  }
  return (
    <div className="sc-sleeper" style={{ aspectRatio: `${width} / ${height}` }}>
      <div className="sc-sleeper-body">
        <img src={src} alt="" width={width} height={height} decoding="async" />
        {bubbleStyle && <span className="sc-bubble" style={bubbleStyle} />}
        <span className="sc-zzz"><span>z</span><span>z</span><span>Z</span></span>
      </div>
    </div>
  )
}

export default function NotFound() {
  const { t } = useLocale()
  const figure = notFoundFigure
  return (
    <div className="sc sc-404">
      <HudBackdrop />
      <HudFrame left="[ 404 ]" right="SIGNAL LOST" />
      <ShowcaseTop brandLabel={t('public.homeLabel')} />
      <main className="sc-frame sc-404-main">
        <div className="sc-404-stage" aria-hidden="true">
          <div className="sc-halo" />
          <div className="sc-pool" />
          {figure && <Sleeper figure={figure} />}
        </div>
        <div className="sc-404-copy">
          <span className="sc-tag sc-mono">[ 404 ] {t('show.notFoundCaption')}</span>
          <h1>{t('route.notFound')}</h1>
          <p>{t('route.notFoundHint')}</p>
          <div className="sc-404-actions">
            <a href="/" className="sc-btn"><Home size={17} aria-hidden="true" />{t('show.backHome')}</a>
            <a href="/vault" className="sc-quiet-link"><LockKeyhole size={16} aria-hidden="true" />{t('nav.vault')}</a>
          </div>
        </div>
      </main>
      <ShowcaseFooter />
    </div>
  )
}
