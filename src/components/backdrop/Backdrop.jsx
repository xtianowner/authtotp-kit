import { cn } from '../../lib/cn.js'

// 设计型氛围背景（默认/最轻；零依赖、双主题、reduced-motion 安全）。分层合成，参考 Linear/Vercel/Stripe/Framer：
//   色场 variant + 结构层 pattern(网格/点阵，边缘径向遮罩淡出) + grain(噪点去断带+质感) + vignette(暗角聚焦)。
//   所有层值集中在 tokens.css / index.css(.bd-*)；本组件只负责开关与堆叠顺序，不硬编码视觉。
// ⚠️ 宿主须 `relative isolate`（fixed 用法则外层容器别铺不透明底色，交给 body --bg），否则 -z-10 被祖先背景盖住。详见 §3.5。
//   富 WebGL 场景改用 react-bits 背景（Aurora/Particles，自行 reduced-motion 兜底）。
//   variant : 'glow' | 'mesh' | 'aurora' | 'none'   色场（aurora 配 animate 可缓慢漂移；reduced-motion 自动冻结）
//   pattern : 'none' | 'grid' | 'dots'              结构层（半透明 + 遮罩淡出边缘 → 工程感而非廉价感）
//   grain   : bool 噪点质感   vignette: bool 暗角   animate: bool aurora 漂移
//   fixed   : true=铺满视口随屏固定(页面级氛围) | false=铺满最近 relative 容器(区块级)
export default function Backdrop({
  variant = 'mesh',
  pattern = 'none',
  grain = false,
  vignette = false,
  animate = false,
  fixed = true,
  className = '',
}) {
  return (
    <div
      aria-hidden
      className={cn(fixed ? 'fixed' : 'absolute', 'inset-0 -z-10 overflow-hidden pointer-events-none', className)}
    >
      {variant === 'glow' && <div className="absolute inset-0 bd-glow" />}
      {variant === 'mesh' && <div className="absolute inset-0 bd-mesh" />}
      {variant === 'aurora' && <div className={cn('absolute inset-0 bd-aurora', animate && 'bd-animate')} />}
      {pattern === 'grid' && <div className="absolute inset-0 bd-grid" />}
      {pattern === 'dots' && <div className="absolute inset-0 bd-dots" />}
      {vignette && <div className="absolute inset-0 bd-vignette" />}
      {grain && <div className="absolute inset-0 bd-grain" />}
    </div>
  )
}
