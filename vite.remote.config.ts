import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'

// Remote Web専用ビルド設定
export default defineConfig({
  plugins: [react()],
  base: './',
  root: path.resolve(__dirname, 'src/remote-web'),
  publicDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'electron/main/core/remote-web-dist'),
    emptyOutDir: true,
    minify: 'terser',
    rollupOptions: {
      input: path.resolve(__dirname, 'src/remote-web/index.html'),
    },
  },
  css: {
    postcss: './postcss.config.js',
  },
})
