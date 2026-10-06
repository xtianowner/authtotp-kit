import { cn } from '../../lib/cn.js'

// 图片背景（opt-in，仅特定场景如摄影 hero）。规则见 agent frontend-reactbits「动效优化 §3.5」：
//  - 来源用免版权(Unsplash/Pexels)，提供 AVIF/WebP + srcSet/sizes 响应式（别塞 4k 原图）
//  - loading="lazy" decoding="async"；强制 scrim 保文字对比；双主题各自处理或仅暗场景用
//   src/srcSet/sizes/alt: 标准 <img> 属性    scrim: 是否叠加对比保护层(默认 true)
export default function ImageBackground({ src, srcSet, sizes, alt = '', scrim = true, fixed = false, className = '' }) {
  return (
    <div
      aria-hidden={alt === ''}
      className={cn(fixed ? 'fixed' : 'absolute', 'inset-0 -z-10 overflow-hidden pointer-events-none', className)}
    >
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
      {scrim && <div className="absolute inset-0 bg-scrim" />}
    </div>
  )
}
