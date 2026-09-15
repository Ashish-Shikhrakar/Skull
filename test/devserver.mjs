// Play the real game locally with no Supabase project: PGlite behind just enough of
// PostgREST for supabase-js to talk to. Dev only — no auth, no realtime socket.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { freshDb } from './harness.js'

const PORT = Number(process.env.PORT || 5179)
const db = await freshDb()

const CASTS = { p_game: '::uuid', p_act: '::jsonb' }
const MIME = { html: 'text/html', js: 'text/javascript', css: 'text/css', json: 'application/json' }

const body = req => new Promise(res => { let b = ''; req.on('data', c => b += c); req.on('end', () => res(b)) })

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, type, data) => { res.writeHead(code, { 'content-type': type }); res.end(data) }

  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const fn = url.pathname.split('/').pop()
    if (!/^skull_(create|join|act|view)$/.test(fn)) return send(404, MIME.json, '{"message":"no such function"}')
    const args = JSON.parse((await body(req)) || '{}')
    const keys = Object.keys(args)
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${CASTS[k] || '::text'}`)}) as v`
    const vals = keys.map(k => (CASTS[k] === '::jsonb' ? JSON.stringify(args[k]) : args[k]))
    try {
      const r = await db.query(sql, vals)
      send(200, MIME.json, JSON.stringify(r.rows[0].v))
    } catch (e) {
      send(400, MIME.json, JSON.stringify({ message: e.message, code: e.code ?? 'P0001' }))
    }
    return
  }

  // Serve the real client, but hand it this server instead of a Supabase project.
  if (url.pathname === '/config.js') {
    return send(200, MIME.js,
      `export const SUPABASE_URL = 'http://localhost:${PORT}'\nexport const SUPABASE_ANON_KEY = 'local-dev'\n`)
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  try {
    const buf = await readFile(new URL(`../web/${file}`, import.meta.url))
    send(200, MIME[file.split('.').pop()] ?? 'application/octet-stream', buf)
  } catch { send(404, 'text/plain', 'not found') }
}).listen(PORT, () => console.log(`skull dev table on http://localhost:${PORT}`))
