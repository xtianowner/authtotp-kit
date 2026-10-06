import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Fonts are always emitted as files: the backend CSP is font-src 'self', which blocks data: URIs.
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined),
  },
  server: {
    port: Number(process.env.AUTHTOTP_FRONTEND_PORT ?? 18474),
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.AUTHTOTP_PORT ?? 18473}`,
      '/v1': `http://127.0.0.1:${process.env.AUTHTOTP_PORT ?? 18473}`,
      '/health': `http://127.0.0.1:${process.env.AUTHTOTP_PORT ?? 18473}`,
    },
  },
})
