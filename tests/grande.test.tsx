import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Consultas grandes: el panel nunca debe quedar en negro. El motor descarta un
// Client cuyas props pasan de 100 000 caracteres o 20 000 valores, o cuyo dibujo
// pasa de 100 000 caracteres; antes bastaba un SELECT TOP (1000) * de una tabla
// de ~15 columnas. El puente es falso: nada toca una base.

const HGI = { id: 'chgi', nombre: 'HGI', motor: 'mssql', host: 'falso.invalid', puerto: '1433', usuario: 'x', base: 'B', color: '#c42b1c', soloLectura: true, ssh: null }

type Conj = { columnas: string[]; tipos?: string[]; filas: unknown[][]; mensajes?: string[] }

function erp(n: number): Conj {
  const columnas = ['IntEmpresa', 'IntTransaccion', 'IntDocumento', 'DatFecha', 'DatFecha1', 'DatVencimiento', 'IntAno', 'IntPeriodo', 'IntAnoCartera', 'IntPeriodoCartera', 'StrTercero', 'StrClase', 'IntCartera', 'StrCCosto', 'IntEstado', 'IntValor', 'IntIva', 'IntTotal', 'StrReferencia', 'StrUsuario', 'StrObservaciones', 'IntBodega', 'StrVendedor']
  const filas = Array.from({ length: n }, (_, i) => [1, 'HE', 2499293 - i, '2026-10-30 13:45:12.000', '2026-10-30 13:45:12.000', '2026-10-30 00:00:00.000', 2026, 10, 2026, 10, '222222222222', '13050502', 0, '01', 0, '125000.0000', '19950.0000', '144950.0000', 'FE-' + (998877 - i), 'SPEED', 'Venta POS isla 3 turno 2', '01', '1094567890'])
  return { columnas, filas }
}

const rejilla = (n: number, c: number): Conj => ({
  columnas: Array.from({ length: c }, (_, i) => 'c' + i),
  filas: Array.from({ length: n }, () => Array.from({ length: c }, (_, i) => 'v' + i)),
})

function puente(on: On, conj: () => Conj, objetos = 0, paraPegar = ''): void {
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux x86_64\n' : e.argv[0] === 'wl-paste' ? paraPegar : '', stderr: '' } }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.spawn', async function* () { yield { stream: 'stdout', text: '{"socket":"/tmp/p.sock"}\n' }; return { value: { code: 0, signal: null } } } as never)
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' ? [HGI] : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [{ id: 'estudio-sql' }] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__estudio-sql__consultar' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('http.fetch', ($, e) => {
    const ruta = new URL(e.url).pathname
    const cuerpo = JSON.parse(String(e.init?.body ?? '{}')) as { database?: string }
    const ok = (dato: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(dato) } }) as never
    if (ruta === '/schema') {
      if (!cuerpo.database) return ok({ databases: ['B'] })
      return ok({ objects: Array.from({ length: objetos }, (_, i) => ({ schema: 'dbo', name: 'Tabla' + String(i).padStart(4, '0'), kind: 'table' })) })
    }
    if (ruta !== '/query') return ok({ ok: true })
    const c = conj()
    return ok({
      results: [{ columns: c.columnas, types: c.tipos ?? c.columnas.map(() => 'nvarchar'), rows: c.filas, truncated: false }],
      messages: (c.mensajes ?? [`(${c.filas.length} filas)`]).map(text => ({ text })),
      ms: 40,
      failed: false,
    })
  })
}

const texto = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(texto).join('') : '')
const contar = (v: unknown): number => (v === null || typeof v !== 'object' ? 1 : 1 + (Array.isArray(v) ? v : Object.values(v as object)).reduce((a: number, x) => a + contar(x), 0))

async function montar($: any, W = 134, H = 42) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'estudio-sql', surface: 'terminal', component: 'Pane', requestId: 'estudio-sql', props: { title: 'Estudio SQL', isFocused: true, bodyColumns: W, placement: 'dock' } as never, viewport: { columns: W + 79, rows: H + 5 } })
  await ui.resize({ columns: W, rows: H } as never)
  /** Las líneas del panel; falla si el motor lo descartó (el «negro»). */
  const lineas = async (): Promise<string[]> => {
    await ui.advance(120)
    const arbol = (await ui.drawn({ in: 'estudio' } as never)) as { children?: unknown[] }
    return (arbol.children ?? []).map(texto)
  }
  /** Lo que pesan las props que recibe el panel: siempre bajo el tope del motor. */
  const props = async () => {
    const buscar = (n: any): any => (n && typeof n === 'object' ? (n.type === 'Client' ? n : (n.children ?? []).map(buscar).find(Boolean)) : undefined)
    const cl = buscar(await ui.drawn())
    expect(cl).toBeDefined()
    const p = cl.props?.props
    return { caracteres: JSON.stringify(p).length, valores: contar(p), p }
  }
  const clic = async (buscado: string | RegExp, desfase = 1) => {
    const ls = await lineas()
    const y = ls.findIndex(l => (typeof buscado === 'string' ? l.includes(buscado) : buscado.test(l)))
    expect(y).toBeGreaterThan(-1)
    const x = typeof buscado === 'string' ? ls[y]!.indexOf(buscado) : ls[y]!.search(buscado)
    await ui.pointer({ type: 'down', x: x + desfase, y, button: 'left' })
    await ui.pointer({ type: 'up', x: x + desfase, y, button: 'left' })
  }
  /** Un clic en la primera fila de resultados: deja el foco en la cuadrícula. */
  const clicFila1 = async () => {
    const ls = await lineas()
    const y = ls.findIndex(l => l.includes(' Resultados ')) + 2
    expect(y).toBeGreaterThan(1)
    const x = ls[y]!.indexOf('│') + 10
    await ui.pointer({ type: 'down', x, y, button: 'left' })
    await ui.pointer({ type: 'up', x, y, button: 'left' })
  }
  const consultar = (titulo: string) => $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'HGI', sql: 'SELECT TOP (1000) * FROM t', titulo } as never)
  return { ui, lineas, props, clic, clicFila1, consultar }
}

async function bajoElTope(props: () => Promise<{ caracteres: number; valores: number }>) {
  const x = await props()
  expect(x.caracteres).toBeLessThan(100_000)
  expect(x.valores).toBeLessThan(20_000)
}

test('tabla de 23 columnas × 1000 filas (SELECT TOP 1000 *): se ve, normal y ampliado', async ($, on) => {
  puente(on, () => erp(1000))
  for (const [W, H] of [[134, 42], [189, 42], [260, 70]] as const) {
    const p = await montar($, W, H)
    await p.consultar('ancha')
    expect((await p.lineas()).join('\n')).toContain('IntEmpresa')
    await bajoElTope(p.props)
    await p.ui.unmount()
  }
})

test('300 columnas × 1000 filas: se recorren columnas y filas sin perder el panel', async ($, on) => {
  puente(on, () => rejilla(1000, 300))
  const p = await montar($)
  await p.consultar('rejilla')
  let ls = await p.lineas()
  expect(ls.join('\n')).toContain(' c0')
  await bajoElTope(p.props)
  // Foco en los resultados: un clic en la fila 1.
  await p.clicFila1()
  for (let i = 0; i < 70; i++) await p.ui.key({ key: 'right' })
  ls = await p.lineas()
  expect(ls.join('\n')).toContain(' c70')
  expect(ls.join('\n')).toContain('v70')
  for (let i = 0; i < 40; i++) await p.ui.key({ key: 'pagedown' })
  ls = await p.lineas()
  expect(ls.join('\n')).toMatch(/\b1000 /)
  expect(ls.join('\n')).toContain('v70')
  await bajoElTope(p.props)
  await p.ui.unmount()
})

test('celdas de 1 MB: se ven recortadas con «…»', async ($, on) => {
  const largo = 'x'.repeat(1_000_000)
  puente(on, () => ({ columnas: ['id', 'cuerpo', 'fin'], filas: Array.from({ length: 50 }, (_, i) => [i, largo, 'z']) }))
  const p = await montar($)
  await p.consultar('largas')
  expect((await p.lineas()).join('\n')).toContain('xxx…')
  await bajoElTope(p.props)
  await p.ui.unmount()
})

test('muchas consultas grandes seguidas no se acumulan hasta el negro', async ($, on) => {
  puente(on, () => erp(500))
  const p = await montar($)
  for (let i = 0; i < 8; i++) await p.consultar('c' + i)
  expect((await p.lineas()).join('\n')).toContain('IntEmpresa')
  await bajoElTope(p.props)
  const { p: modelo } = await p.props()
  // Claude conserva 4 pestañas: las cerradas ya no viajan ni se guardan.
  expect(Object.keys(modelo.resultados).length).toBeLessThanOrEqual(5)
  await p.ui.unmount()
})

test('reabrir /sql después de una consulta grande dibuja el panel', async ($, on) => {
  puente(on, () => erp(1000))
  const p = await montar($)
  await p.consultar('grande')
  await p.lineas()
  await p.ui.unmount()
  const q = await montar($)
  expect((await q.lineas()).join('\n')).toContain('Explorador')
  await bajoElTope(q.props)
  await q.ui.unmount()
})

test('caracteres de control C1 (texto mal convertido) no tumban el panel', async ($, on) => {
  puente(on, () => ({ columnas: ['MAR\u0081A', 'nombre'], filas: Array.from({ length: 30 }, () => ['X\u009fY', 'JOS\u0089']), mensajes: ['aviso \u0085 raro'] }))
  const p = await montar($)
  await p.consultar('c1')
  const ls = (await p.lineas()).join('\n')
  expect(ls).toContain('MAR A')
  expect(ls).not.toMatch(/[\u0080-\u009f]/)
  await p.ui.unmount()
})

test('un número largo después de la fila 200 se ve entero, no cortado', async ($, on) => {
  const filas = Array.from({ length: 600 }, (_, i) => [i, i === 400 ? 1234567890123 : 7])
  puente(on, () => ({ columnas: ['n', 'valor'], tipos: ['int', 'decimal'], filas }))
  const p = await montar($)
  await p.consultar('numeros')
  await p.clicFila1()
  let visto = false
  for (let i = 0; i < 30 && !visto; i++) {
    await p.ui.key({ key: 'pagedown' })
    const ls = (await p.lineas()).join('\n')
    expect(ls).not.toMatch(/\b1234\b(?!5)/)
    visto = ls.includes('1234567890123')
  }
  expect(visto).toBe(true)
  await p.ui.unmount()
})

test('una base con 2500 tablas en el explorador no deja el panel en negro', async ($, on) => {
  puente(on, () => rejilla(1, 1), 2500)
  const p = await montar($)
  await p.clic('◆ HGI', 2)
  await p.clic(/▸ ▪ B\b/, 0)
  await p.clic('Tablas', 0)
  expect((await p.lineas()).join('\n')).toContain('Tabla0000')
  await bajoElTope(p.props)
  // Viajan 300; el panel sabe que hay 2500 y lo dice al final de la lista.
  const { p: modelo } = await p.props()
  expect(modelo.esquemas.chgi.objetos.B.length).toBe(300)
  expect(modelo.esquemas.chgi.totales.B.table).toBe(2500)
  await p.ui.unmount()
})

test('pegar un SQL de 50 000 caracteres: se ve y el panel sigue vivo', async ($, on) => {
  const sql = Array.from({ length: 900 }, (_, i) => `SELECT ${i} AS n, 'relleno relleno relleno' AS t UNION ALL`).join('\n')
  puente(on, () => rejilla(10, 3), 0, sql)
  const p = await montar($)
  await p.clic('Haz clic aquí')
  await p.ui.key({ key: 'v', ctrl: true } as never)
  const ls = (await p.lineas()).join('\n')
  expect(ls).toContain('UNION ALL')
  await bajoElTope(p.props)
  await p.ui.unmount()
})
