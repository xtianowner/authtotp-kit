// Motion (JS) mirror of the CSS motion tokens in src/styles/tokens.css: --dur .45s, --ease cubic-bezier(0.22, 1, 0.36, 1),
// small interactions ~.15s. Reduced motion is handled by <MotionConfig reducedMotion="user"> in the entry files: transforms
// are dropped and only opacity keeps animating.
export const EASE = [0.22, 1, 0.36, 1]
export const DUR = 0.45
export const DUR_EXIT = 0.25
export const DUR_FAST = 0.15

export const enter = { duration: DUR, ease: EASE }
export const exit = { duration: DUR_EXIT, ease: EASE }
