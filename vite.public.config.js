import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config.js'

// Standalone public tool: `npm run build:public` → dist-public/index.html. Reuses the main config (React plugin,
// fonts always emitted as files) and only swaps the entry. public/ (theme-init.js + favicons) is copied as usual.
const ENTRY_HTML = 'public-tool.html'

// Optional VITE_VAULT_URL shows the 私有保险库 switch, linked to that absolute address; refuse anything else.
const vaultUrl = process.env.VITE_VAULT_URL
if (vaultUrl) {
  let protocol = ''
  try { protocol = new URL(vaultUrl).protocol } catch { /* reported below */ }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`VITE_VAULT_URL 必须是完整的 http(s) 绝对地址，例如 https://2fa.example.com/vault；当前值：${vaultUrl}`)
  }
}

// The entry is public-tool.html so it never collides with the vault's index.html; ship it as index.html.
function emitEntryAsIndexHtml() {
  return {
    name: 'authtotp-public-entry-as-index',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle[ENTRY_HTML]
      if (!html) this.error(`${ENTRY_HTML} was not emitted`)
      delete bundle[ENTRY_HTML]
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html.source })
    },
  }
}

// The brand package config (src/brand/index.js) imports every figure; Vite emits an imported image even when the
// public page tree-shakes it away. Drop images that no chunk, stylesheet or HTML references, so the static site
// only ships the figure the public home actually shows.
function dropUnreferencedImages() {
  return {
    name: 'authtotp-public-drop-unreferenced-images',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const sources = Object.values(bundle)
        .map((item) => (item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : ''))
        .join('\n')
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'asset' || !/\.(webp|png|jpe?g|avif)$/i.test(fileName)) continue
        const base = fileName.split('/').pop()
        if (!sources.includes(base)) delete bundle[fileName]
      }
    },
  }
}

export default mergeConfig(baseConfig, defineConfig({
  plugins: [emitEntryAsIndexHtml(), dropUnreferencedImages()],
  build: {
    outDir: 'dist-public',
    emptyOutDir: true,
    rollupOptions: { input: ENTRY_HTML },
  },
}))
