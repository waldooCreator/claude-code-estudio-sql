import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// El motor bajo el mod: un puente de mentira que responde por «http».
const portapapeles = { copiado: [] as string[], paraPegar: 'TOP 5 ' }

function puenteFalso(on: On, pedidos: { ruta: string; cuerpo: unknown }[], guardadas: unknown[] = []): void {
  on('process.run', ($, e) => {
    const [cmd] = e.argv
    if (cmd === 'wl-copy') portapapeles.copiado.push(e.init?.stdin ?? '')
    const stdout = cmd === 'uname' ? 'Linux x86_64\n' : cmd === 'wl-paste' ? portapapeles.paraPegar : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('fs.exists', () => ({ value: true }) as never)
  on('process.spawn', async function* () {
    // El kit espera a que termine todo lo pendiente: este puente responde y termina.
    yield { stream: 'stdout', text: '{"socket":"/tmp/puente.sock"}\n' }
    return { value: { code: 0, signal: null } }
  } as never)
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' && guardadas.length ? guardadas : undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__estudio-sql__consultar' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('http.fetch', ($, e) => {
    const ruta = new URL(e.url).pathname
    const cuerpo = JSON.parse(e.init?.body ?? '{}')
    pedidos.push({ ruta, cuerpo })
    const respuestas: Record<string, unknown> = {
      '/secret/set': { ok: true },
      '/close': { ok: true },
      '/schema': cuerpo.database ? { objects: [{ schema: '', name: 'ventas', kind: 'table' }] } : { databases: ['main'] },
      '/query': {
        results: [{ columns: ['sucursal', 'total'], types: ['text', 'integer'], rows: [['Norte', 58300], ['Centro', null]], truncated: false }],
        messages: [{ text: '(2 filas)' }],
        ms: 12,
        failed: false,
      },
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(respuestas[ruta] ?? { error: 'ruta desconocida' }) } } as never
  })
}

// Las filas del dibujo del panel como texto plano, una por fila de la terminal.
async function filas(ui: { drawn: (s?: never) => Promise<unknown> }): Promise<string[]> {
  const arbol = (await ui.drawn({ in: 'estudio' } as never)) as { children?: { children?: unknown[] }[] }
  const texto = (n: unknown): string =>
    typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(texto).join('') : ''
  return (arbol.children ?? []).map(texto)
}

const PANE = { title: 'Estudio SQL', isFocused: true, bodyColumns: 120, placement: 'dock' as const } as never

// Como la terminal: el espacio llega con el nombre «space».
async function escribir(ui: { key: (e: { key: string; ctrl?: true }) => Promise<void> }, texto: string) {
  for (const ch of texto) await ui.key({ key: ch === ' ' ? 'space' : ch })
}

test('crear una conexión SQLite, escribir una consulta y ver el resultado', async ($, on) => {
  const pedidos: { ruta: string; cuerpo: unknown }[] = []
  puenteFalso(on, pedidos)
  const ui = await $.ui.mount({
    plugin: 'estudio-sql',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'estudio-sql',
    props: PANE,
    viewport: { columns: 120, rows: 40 },
  })
  await ui.resize({ columns: 120, rows: 40 } as never)
  const ver = (texto: RegExp) => ui.find({ in: 'estudio', text: texto })
  await ui.drawn({ in: 'estudio' } as never)
  expect(await ver(/Aún no hay conexiones/)).toBeDefined()

  // «+ Nueva conexión» del estado vacío: centrado, fila 14.
  await ui.pointer({ type: 'down', x: 55, y: 14, button: 'left' })
  expect(await ver(/Conectar al servidor/)).toBeDefined()

  // Motor SQLite (cuarto botón de la fila de motores).
  await ui.pointer({ type: 'down', x: 72, y: 10, button: 'left' })
  expect(await ver(/Archivo/)).toBeDefined()

  await escribir(ui, 'Local')
  await ui.key({ key: 'tab' })
  await escribir(ui, '/tmp/prueba.db')
  await ui.key({ key: 'return' })
  await ui.advance(50)

  const guardado = pedidos.find(p => p.ruta === '/schema')
  expect(guardado).toBeDefined()
  expect(await ver(/Local/)).toBeDefined()
  expect(await ver(/main/)).toBeDefined()

  // Clic en el editor y una consulta; Ctrl+Enter la ejecuta.
  await ui.pointer({ type: 'down', x: 60, y: 5, button: 'left' })
  await escribir(ui, 'SELECT * FROM ventas')
  await ui.key({ key: '[15~' }) // F5 cruda: no debe escribirse nada
  await ui.key({ key: 'e', ctrl: true })
  await ui.advance(50)

  const consulta = pedidos.find(p => p.ruta === '/query')
  expect(consulta?.cuerpo).toMatchObject({ sql: 'SELECT * FROM ventas', conn: { engine: 'sqlite', host: '/tmp/prueba.db' } })
  expect(await ver(/Norte/)).toBeDefined()
  expect(await ver(/NULL/)).toBeDefined()
  expect(await ver(/Consulta ejecutada correctamente/)).toBeDefined()

  // Clic derecho sobre «Norte» (primera fila de resultados) → «Copiar celda».
  const yNorte = (await filas(ui)).findIndex(t => /Norte/.test(t) && !/consulta/.test(t))
  const xNorte = (await filas(ui))[yNorte]!.indexOf('Norte')
  expect(yNorte).toBeGreaterThan(0)
  await ui.pointer({ type: 'down', x: xNorte, y: yNorte, button: 'right' })
  expect(await ver(/Copiar celda/)).toBeDefined()
  const yMenu = (await filas(ui)).findIndex(t => /Copiar celda/.test(t))
  const xMenu = (await filas(ui))[yMenu]!.indexOf('Copiar celda')
  await ui.pointer({ type: 'down', x: xMenu, y: yMenu, button: 'left' })
  await ui.advance(20)
  expect(portapapeles.copiado).toContain('Norte')

  // Ctrl+A selecciona todo en el editor; Ctrl+V pega lo del portapapeles en su lugar.
  await ui.pointer({ type: 'down', x: 60, y: 5, button: 'left' })
  await ui.pointer({ type: 'up', x: 60, y: 5, button: 'left' })
  await ui.key({ key: 'a', ctrl: true })
  await ui.key({ key: 'v', ctrl: true })
  await ui.advance(20)
  await escribir(ui, 'x')
  await ui.key({ key: 'e', ctrl: true })
  await ui.advance(50)
  expect(pedidos.filter(p => p.ruta === '/query').at(-1)?.cuerpo).toMatchObject({ sql: 'TOP 5 x' })
  await ui.unmount()
})

const LOCAL = { id: 'c1', nombre: 'Local', motor: 'sqlite', host: '/tmp/prueba.db', puerto: '', usuario: '', base: '', color: '#0078d4', soloLectura: false, ssh: null }

test('Claude consulta a la vista: abre su pestaña, corre en solo lectura y recibe la tabla', async ($, on) => {
  const pedidos: { ruta: string; cuerpo: unknown }[] = []
  puenteFalso(on, pedidos, [LOCAL])
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  const ui = await $.ui.mount({
    plugin: 'estudio-sql',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'estudio-sql',
    props: PANE,
    viewport: { columns: 120, rows: 40 },
  })
  await ui.resize({ columns: 120, rows: 40 } as never)
  await ui.drawn({ in: 'estudio' } as never)

  const r = await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'local', sql: 'SELECT sucursal, total FROM ventas', titulo: 'ventas' } as never)
  const texto = JSON.stringify(r)
  expect(texto).toContain('| Norte | 58300 |')
  expect(texto).toContain('solo lectura')
  expect(pedidos.find(p => p.ruta === '/query')?.cuerpo).toMatchObject({ sql: 'SELECT sucursal, total FROM ventas', conn: { readOnly: true } })

  await ui.advance(50)
  const ver = (t: RegExp) => ui.find({ in: 'estudio', text: t })
  expect(await ver(/ventas\.sql/)).toBeDefined()
  expect(await ver(/SELECT sucursal, total FROM ventas/)).toBeDefined()
  expect(await ver(/Norte/)).toBeDefined()

  // Una conexión que no existe: la respuesta trae la lista.
  const mal = JSON.stringify(await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'otra', sql: 'SELECT 1' } as never))
  expect(mal).toContain('«Local»')
  await ui.unmount()
})

test('los divisores se arrastran: el explorador cambia de ancho y el editor de alto', async ($, on) => {
  const pedidos: { ruta: string; cuerpo: unknown }[] = []
  puenteFalso(on, pedidos, [LOCAL])
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  const ui = await $.ui.mount({
    plugin: 'estudio-sql',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'estudio-sql',
    props: PANE,
    viewport: { columns: 120, rows: 40 },
  })
  await ui.resize({ columns: 120, rows: 40 } as never)
  await ui.drawn({ in: 'estudio' } as never)
  const lineas = await filas(ui)
  // El borde del explorador: la columna del «┃».
  const yBorde = lineas.findIndex(t => t.includes('┃'))
  const xBorde = lineas[yBorde]!.indexOf('┃')
  expect(xBorde).toBeGreaterThan(20)
  await ui.pointer({ type: 'down', x: xBorde, y: yBorde, button: 'left' })
  await ui.pointer({ type: 'move', x: xBorde + 10, y: yBorde })
  await ui.pointer({ type: 'up', x: xBorde + 10, y: yBorde, button: 'left' })
  const despues = await filas(ui)
  expect(despues[yBorde]!.indexOf('┃')).toBe(xBorde + 10)

  // La barra de resultados («⇕») baja cinco filas: el editor crece.
  const yBarra = despues.findIndex(t => t.includes('⇕'))
  const xBarra = despues[yBarra]!.indexOf('⇕')
  await ui.pointer({ type: 'down', x: xBarra, y: yBarra, button: 'left' })
  await ui.pointer({ type: 'move', x: xBarra, y: yBarra + 5 })
  await ui.pointer({ type: 'up', x: xBarra, y: yBarra + 5, button: 'left' })
  expect((await filas(ui)).findIndex(t => t.includes('⇕'))).toBe(yBarra + 5)

  // ▲ la sube tres filas.
  const conBarra = await filas(ui)
  const xSube = conBarra[yBarra + 5]!.indexOf('▲')
  await ui.pointer({ type: 'down', x: xSube, y: yBarra + 5, button: 'left' })
  expect((await filas(ui)).findIndex(t => t.includes('⇕'))).toBe(yBarra + 2)
  await ui.unmount()
})

test('una conexión guardada después de abrir el panel se encuentra al pedirla', async ($, on) => {
  const pedidos: { ruta: string; cuerpo: unknown }[] = []
  const guardadas: unknown[] = []
  puenteFalso(on, pedidos, guardadas)
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  guardadas.push(LOCAL)
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'Local', sql: 'SELECT 1' } as never))
  expect(r).toContain('Consulta ejecutada')
  expect(pedidos.some(p => p.ruta === '/query')).toBe(true)
})
