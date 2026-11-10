import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Barras de desplazamiento del editor y de los resultados: flechas, pista y
// pulgar arrastrable. El puente es falso: nada toca una base.

const TIENDA = { id: 'ctienda', nombre: 'Tienda', motor: 'mssql', host: 'falso.invalid', puerto: '1433', usuario: 'x', base: 'B', color: '#c42b1c', soloLectura: true, ssh: null }

type Conj = { columnas: string[]; tipos?: string[]; filas: unknown[][]; mensajes?: string[] }

function ventas(n: number): Conj {
  const columnas = ['NumEmpresa', 'TipoVenta', 'NumVenta', 'FechaVenta', 'FechaRegistro', 'FechaVence', 'NumAnio', 'NumMes', 'NumAnioCorte', 'NumMesCorte', 'CodCliente', 'CodCategoria', 'NumCartera', 'CodSucursal', 'NumEstado', 'ValBase', 'ValImpuesto', 'ValTotal', 'TxtReferencia', 'TxtCajero', 'TxtNotas', 'NumBodega', 'CodVendedor']
  const filas = Array.from({ length: n }, (_, i) => [1, 'VT', 1000000 - i, '2026-10-30 13:45:12.000', '2026-10-30 13:45:12.000', '2026-10-30 00:00:00.000', 2026, 10, 2026, 10, '000000000000', '00000000', 0, '01', 0, '125000.0000', '19950.0000', '144950.0000', 'FV-' + (998877 - i), 'CAJA1', 'Venta de mostrador caja 3', '01', '0000000000'])
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
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' ? [TIENDA] : undefined }) as never)
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
  const consultar = (titulo: string) => $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'Tienda', sql: 'SELECT TOP (1000) * FROM ventas', titulo } as never)
  return { ui, lineas, props, clic, clicFila1, consultar }
}

const W = 134

/** Las filas donde la columna de más a la derecha tiene `c`: las barras verticales. */
const filasCon = (ls: string[], c: string, x = W - 1) => ls.map((l, y) => (l[x] === c ? y : -1)).filter(y => y >= 0)
/** El número de la primera línea a la vista en el editor. */
const primeraLinea = (ls: string[], ed: number) => Number(/│ *(\d+) +SELECT/.exec(ls[ed]!)?.[1])

async function presionar(ui: any, x: number, y: number, hasta?: { x: number; y: number }) {
  await ui.pointer({ type: 'down', x, y, button: 'left' })
  if (hasta) await ui.pointer({ type: 'move', x: hasta.x, y: hasta.y, button: 'left' })
  const fin = hasta ?? { x, y }
  await ui.pointer({ type: 'up', x: fin.x, y: fin.y, button: 'left' })
}

test('editor: la barra vertical desplaza sin mover el cursor y el pulgar se arrastra', async ($, on) => {
  const sql = Array.from({ length: 300 }, (_, i) => `SELECT ${i} AS n UNION ALL`).join('\n')
  puente(on, () => rejilla(3, 2), 0, sql)
  const p = await montar($, W)
  await p.clic('Haz clic aquí')
  await p.ui.key({ key: 'v', ctrl: true } as never)
  let ls = await p.lineas()
  const [ed] = filasCon(ls, '▲')
  const [abajo] = filasCon(ls, '▼')
  expect(ed).toBeDefined()
  // Tras pegar, el cursor está al final y el editor muestra las últimas líneas.
  expect(primeraLinea(ls, ed!)).toBeGreaterThan(250)
  expect(ls.join('\n')).toContain('Ln 300,')

  // ▲: tres líneas arriba; el cursor no se mueve.
  const antes = primeraLinea(ls, ed!)
  await presionar(p.ui, W - 1, ed!)
  ls = await p.lineas()
  expect(primeraLinea(ls, ed!)).toBe(antes - 3)
  expect(ls.join('\n')).toContain('Ln 300,')

  // Pulgar (abajo del todo) arrastrado hasta arriba: se ve la línea 1.
  await presionar(p.ui, W - 1, abajo! - 1, { x: W - 1, y: ed! + 1 })
  ls = await p.lineas()
  expect(primeraLinea(ls, ed!)).toBe(1)

  // Al escribir, el editor vuelve a mostrar el cursor.
  await p.ui.key({ key: 'x' } as never)
  ls = await p.lineas()
  expect(primeraLinea(ls, ed!)).toBeGreaterThan(250)
  await p.ui.unmount()
})

test('editor: la barra horizontal muestra el final de una línea larga', async ($, on) => {
  const sql = 'SELECT ' + Array.from({ length: 60 }, (_, i) => `columna_${i}`).join(', ') + ' FROM t'
  puente(on, () => rejilla(3, 2), 0, sql)
  const p = await montar($, W)
  await p.clic('Haz clic aquí')
  await p.ui.key({ key: 'v', ctrl: true } as never)
  await p.ui.key({ key: 'home' } as never)
  let ls = await p.lineas()
  expect(ls.join('\n')).toContain('SELECT columna_0')
  const y = ls.findIndex(l => l.includes('Ln 1,'))
  const fin = ls[y]!.indexOf('▶')
  expect(fin).toBeGreaterThan(-1)
  for (let i = 0; i < 80; i++) await presionar(p.ui, fin, y)
  ls = await p.lineas()
  expect(ls.join('\n')).toContain('FROM t')
  expect(ls.join('\n')).not.toContain('SELECT columna_0')
  await p.ui.unmount()
})

test('resultados: barras de filas y columnas', async ($, on) => {
  puente(on, () => rejilla(1000, 40))
  const p = await montar($, W)
  await p.consultar('rejilla')
  let ls = await p.lineas()
  const verticales = filasCon(ls, '▲')
  const res = verticales[1]!
  const finRes = filasCon(ls, '▼')[1]!
  expect(res).toBeDefined()
  const fila1 = (ls: string[]) => Number(/(\d+)\s+v0\b/.exec(ls[res]!)?.[1])
  expect(fila1(ls)).toBe(1)

  // Clic en la pista, debajo del pulgar: una página abajo.
  await presionar(p.ui, W - 1, finRes - 1)
  ls = await p.lineas()
  expect(fila1(ls)).toBeGreaterThan(10)

  // El pulgar arrastrado hasta el fondo: se ve la fila 1000.
  // Con 1000 filas el pulgar ocupa una celda; tras una página sigue en la primera de la pista.
  await presionar(p.ui, W - 1, res + 1, { x: W - 1, y: finRes })
  ls = await p.lineas()
  expect(ls.join('\n')).toMatch(/1000\s+v0/)

  // ▶ de la barra horizontal: la primera columna deja de ser c0.
  const yh = finRes + 1
  expect(ls[yh]![W - 2]).toBe('▶')
  expect(ls[res - 1]).toContain(' c0 ')
  await presionar(p.ui, W - 2, yh)
  ls = await p.lineas()
  expect(ls[res - 1]).not.toContain(' c0 ')
  expect(ls[res - 1]).toContain(' c1 ')
  await p.ui.unmount()
})
