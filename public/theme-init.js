// Pre-paint display preference: font size (the only one left — AuthTOTP is dark-only, 视觉基线 v1.4 §14, so there is
// no theme to restore; the colours, theme-color and color-scheme are static in the CSS and the HTML head).
// Loaded as a same-origin classic script from index.html / public-tool.html because the CSP (script-src 'self')
// blocks inline scripts; it runs before first paint so the first frame already has the right size.
(function () {
  var size = null
  try { size = localStorage.getItem('fontSize') } catch (e) { /* storage blocked: default size */ }
  document.documentElement.dataset.fontSize = size === 'compact' || size === 'large' ? size : 'default'
})()
