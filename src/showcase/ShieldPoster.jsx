import { useId } from 'react'
import { shieldPath } from './shieldGeometry.js'

// Static poster of the 3D shield (reduced motion / no WebGL / lost context): the same contour drawn as SVG, no
// animation. Colours come from tokens via CSS (showcase.css .sc-poster *).
const PATH = shieldPath()

export default function ShieldPoster({ tilt = 0 }) {
  const id = `scp${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg className="sc-poster" viewBox="-4 -4 108 108" style={{ '--tilt': `${tilt}deg` }} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="sc-poster-stop-a" />
          <stop offset="1" className="sc-poster-stop-b" />
        </linearGradient>
      </defs>
      <path d={PATH} fill={`url(#${id}-fill)`} />
      <path d={PATH} fill="none" className="sc-poster-rim" />
      <path d={PATH} fill="none" className="sc-poster-inner" transform="translate(50 52) scale(0.8) translate(-50 -52)" />
      <path className="sc-poster-key" d="M50 32.5a7.7 7.7 0 0 1 3.4 14.6L56 61H44l2.6-13.9A7.7 7.7 0 0 1 50 32.5Z" />
    </svg>
  )
}
