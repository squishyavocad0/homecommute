import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

// `VITE_DEMO=1 vite build` → self-contained demo: fake data in localStorage, no Supabase client bundled,
// own app name + service-worker cache so it never collides with the real app.
export default defineConfig(({ mode }) => {
  const demo = (process.env.VITE_DEMO ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_DEMO) === '1'
  if (!demo) return { plugins: [react()] }
  return {
    plugins: [react(), {
      name: 'our-house-demo',
      transformIndexHtml: (html) => html
        .replace('content="Our House"', 'content="Our House Demo"')
        .replace('<title>Our House 🏠</title>', '<title>Our House Demo 🏠</title>'),
      closeBundle() {
        const out = (f) => fileURLToPath(new URL(`./dist/${f}`, import.meta.url))
        const sw = readFileSync(out('sw.js'), 'utf8').replace(/const C = '([^']+)'/, (m, c) => `const C = 'ourhouse-demo-${c.replace('huis-', '')}'`)
        writeFileSync(out('sw.js'), sw)
        const m = JSON.parse(readFileSync(out('manifest.webmanifest'), 'utf8'))
        Object.assign(m, { name: 'Our House Demo – traffic lights & chores', short_name: 'Our House Demo', id: '/?demo' })
        writeFileSync(out('manifest.webmanifest'), JSON.stringify(m, null, 2))
      },
    }],
    resolve: { alias: [{ find: /^\.\/supabase\.js$/, replacement: fileURLToPath(new URL('./src/demo/backend.js', import.meta.url)) }] },
  }
})
