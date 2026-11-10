import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Windows (simulado) y el respaldo por TCP: el puente se anuncia con url y token
// en vez de socket, el portapapeles va por PowerShell en UTF-8 y el sistema se
// reconoce por la variable OS sin preguntar a uname. El puente es falso.

const LOCAL = { id: 'c1', nombre: 'Local', motor: 'sqlite', host: 'C:\\Users\\Ana\\datos\\tienda.db', puerto: '', usuario: '', base: '', color: '#0078d4', soloLectura: false, ssh: null }

type Pedido = { url: string; socketPath?: string; token?: string; ruta: string }
type Registro = { pedidos: Pedido[]; lanzados: string[][]; ejecutados: { argv: string[]; stdin?: string }[] }

const RESPUESTAS: Record<string, unknown> = {
  '/schema': { databases: ['main'] },
  '/query': { results: [{ columns: ['sucursal', 'total'], types: ['text', 'integer'], rows: [['Peñalisa', 10]], truncated: false }], messages: [], ms: 3, failed: false },
  '/diagnostico': { version: '0.2.0', os: 'windows', arch: 'amd64', transporte: 'tcp', llavero: { ok: true, nombre: 'el Administrador de credenciales de Windows', detalle: '' } },
}

/**
 * Un puente falso. `anuncios` es lo que imprime cada arranque, en orden;
 * `socketRoto` hace que todo pedido por socket falle como si el motor no lo soportara.
 */
function puente(on: On, r: Registro, anuncios: string[], socketRoto = false, uname = ''): void {
  on('process.run', ($, e) => {
    r.ejecutados.push({ argv: [...e.argv], stdin: e.init?.stdin })
    const esUname = e.argv[0] === 'uname'
    return { value: { exitCode: esUname && !uname ? 1 : 0, stdout: esUname ? uname : '', stderr: '' } } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    r.lanzados.push([...e.argv])
    yield { stream: 'stdout', text: anuncios[Math.min(r.lanzados.length - 1, anuncios.length - 1)] + '\n' }
    return { value: { code: 0, signal: null } }
  } as never)
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' ? [LOCAL] : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [{ id: 'estudio-sql' }] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__estudio-sql__consultar' } }) as never)
  on('session.version', () => ({ value: { version: '2.1.303' } }) as never)
  on('http.fetch', ($, e) => {
    const ruta = new URL(e.url).pathname
    r.pedidos.push({ url: e.url, socketPath: e.init?.socketPath, token: e.init?.headers?.['X-Estudio-Token'], ruta })
    if (socketRoto && e.init?.socketPath) throw new Error('socketPath no soportado')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(RESPUESTAS[ruta] ?? { ok: true }) } } as never
  })
}

const nuevo = (): Registro => ({ pedidos: [], lanzados: [], ejecutados: [] })
const TCP = '{"url":"http://127.0.0.1:50123","token":"t0k3n"}'

test('Windows: lanza el .exe, le habla por 127.0.0.1 con el token y no pregunta a uname', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\\Users\\Ana' })
  const r = nuevo()
  puente(on, r, [TCP])
  await $.session.start({ cwd: 'C:\\Users\\Ana', surface: 'terminal' } as never)
  const res = JSON.stringify(await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'Local', sql: 'SELECT * FROM ventas' } as never))
  expect(res).toContain('Peñalisa')
  expect(r.lanzados[0]![0]).toMatch(/[\\/]bin[\\/]puente-windows-amd64\.exe$/)
  expect(r.ejecutados.some(x => x.argv[0] === 'uname')).toBe(false)
  const q = r.pedidos.find(p => p.ruta === '/query')!
  expect(q.url).toBe('http://127.0.0.1:50123/query')
  expect(q.token).toBe('t0k3n')
  expect(q.socketPath).toBeUndefined()
})

test('si el socket no funciona con este motor, el puente se relanza por TCP y el pedido se repite', async ($, on) => {
  const r = nuevo()
  puente(on, r, ['{"socket":"/tmp/estudio-sql-1/puente.sock"}', TCP], true, 'Linux x86_64\n')
  await $.session.start({ cwd: '/home/ana', surface: 'terminal' } as never)
  const res = JSON.stringify(await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'Local', sql: 'SELECT 1' } as never))
  expect(res).toContain('Peñalisa')
  expect(r.lanzados.length).toBe(2)
  expect(r.lanzados[0]![0]).toMatch(/puente-linux-amd64$/)
  expect(r.lanzados[1]).toContain('-tcp')
  expect(r.pedidos[0]!.socketPath).toBe('/tmp/estudio-sql-1/puente.sock')
  const ultimo = r.pedidos.at(-1)!
  expect(ultimo.url.startsWith('http://127.0.0.1:50123/')).toBe(true)
  expect(ultimo.token).toBe('t0k3n')
})

test('Windows: copiar va por PowerShell en UTF-8 (no por clip.exe) y las tildes llegan enteras', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  const r = nuevo()
  puente(on, r, [TCP])
  await $.session.start({ cwd: 'C:\\Users\\Ana', surface: 'terminal' } as never)
  const ui = await $.ui.mount({
    plugin: 'estudio-sql',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'estudio-sql',
    props: { title: 'Estudio SQL', isFocused: true, bodyColumns: 120, placement: 'dock' } as never,
    viewport: { columns: 120, rows: 40 },
  })
  await ui.resize({ columns: 120, rows: 40 } as never)
  await ui.drawn({ in: 'estudio' } as never)
  await ui.pointer({ type: 'down', x: 60, y: 5, button: 'left' })
  await ui.pointer({ type: 'up', x: 60, y: 5, button: 'left' })
  for (const ch of 'año') await ui.key({ key: ch })
  await ui.key({ key: 'k', ctrl: true })
  await ui.advance(50)
  const copia = r.ejecutados.find(x => x.stdin !== undefined)
  expect(copia?.argv[0]).toBe('powershell.exe')
  expect(copia?.argv.join(' ')).toContain('UTF8')
  expect(copia?.stdin).toContain('año')
  expect(r.ejecutados.some(x => /^clip/.test(x.argv[0] ?? ''))).toBe(false)
  await ui.unmount()
})

test('el diagnóstico dice sistema, transporte, llavero y portapapeles', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT' })
  const r = nuevo()
  puente(on, r, [TCP])
  await $.session.start({ cwd: 'C:\\Users\\Ana', surface: 'terminal' } as never)
  const texto = JSON.stringify(await $.tool.call({ tool: 'mcp__estudio-sql__diagnostico' } as never))
  expect(texto).toContain('windows amd64')
  expect(texto).toContain('✔ El puente arranca')
  expect(texto).toContain('TCP local con token')
  expect(texto).toContain('✔ Llavero')
  expect(texto).toContain('✔ Portapapeles: powershell.exe')
})
