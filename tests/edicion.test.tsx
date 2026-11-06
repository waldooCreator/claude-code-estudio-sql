import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Edición en la cuadrícula: doble clic en una celda, Enter muestra el UPDATE,
// Enter otra vez lo ejecuta. El puente es falso: nada toca una base.

const W = 134
const BASE = { id: 'cprueba', nombre: 'Prueba', motor: 'mssql', host: 'falso.invalid', puerto: '1433', usuario: 'x', base: 'B', color: '#107c10', soloLectura: false, ssh: null }

type Opciones = { soloLectura?: boolean; editable?: { editable: boolean; reason?: string }; errorUpdate?: string }

function puente(on: On, o: Opciones = {}) {
  const llamadas: { ruta: string; cuerpo: any }[] = []
  const filas: unknown[][] = [[1, 'Ana', '10.50'], [2, 'Luis', '20.00']]
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux x86_64\n' : '', stderr: '' } }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.spawn', async function* () { yield { stream: 'stdout', text: '{"socket":"/tmp/p.sock"}\n' }; return { value: { code: 0, signal: null } } } as never)
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' ? [{ ...BASE, soloLectura: !!o.soloLectura }] : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [{ id: 'estudio-sql' }] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__estudio-sql__consultar' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('http.fetch', ($, e) => {
    const ruta = new URL(e.url).pathname
    const cuerpo = JSON.parse(String(e.init?.body ?? '{}'))
    llamadas.push({ ruta, cuerpo })
    const ok = (dato: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(dato) } }) as never
    if (ruta === '/schema') return ok(cuerpo.database ? { objects: [] } : { databases: ['B'] })
    if (ruta === '/query') return ok({ results: [{ columns: ['id', 'nombre', 'saldo'], types: ['int', 'nvarchar', 'decimal'], rows: filas, truncated: false }], messages: [{ text: '(2 filas)' }], ms: 5, failed: false })
    if (ruta === '/editable') return ok({ table: { schema: 'dbo', name: 'clientes' }, display: '[dbo].[clientes]', sources: ['', 'nombre', 'saldo'], key: [0], keyColumns: ['id'], editable: true, ...o.editable })
    if (ruta === '/update') {
      const vista = `UPDATE [dbo].[clientes] SET [${cuerpo.column}] = N'${cuerpo.value}' WHERE [id] = ${cuerpo.key[0].value}`
      if (cuerpo.dryRun) return ok({ sql: vista })
      if (o.errorUpdate) return ok({ error: o.errorUpdate })
      return ok({ ok: true, sql: vista, value: cuerpo.value })
    }
    return ok({ ok: true })
  })
  return llamadas
}

const texto = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(texto).join('') : '')

async function preparar($: any) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'estudio-sql', surface: 'terminal', component: 'Pane', requestId: 'estudio-sql', props: { title: 'Estudio SQL', isFocused: true, bodyColumns: W, placement: 'dock' } as never, viewport: { columns: W + 79, rows: 47 } })
  await ui.resize({ columns: W, rows: 42 } as never)
  const lineas = async (): Promise<string[]> => {
    await ui.advance(120)
    const arbol = (await ui.drawn({ in: 'estudio' } as never)) as { children?: unknown[] }
    return (arbol.children ?? []).map(texto)
  }
  const clic = async (x: number, y: number) => {
    await ui.pointer({ type: 'down', x, y, button: 'left' })
    await ui.pointer({ type: 'up', x, y, button: 'left' })
  }
  const escribir = async (t: string) => {
    for (const ch of t) await ui.key({ key: ch === ' ' ? 'space' : ch } as never)
  }
  // Una consulta escrita y ejecutada como lo haría la persona.
  let ls = await lineas()
  const y = ls.findIndex(l => l.includes('Haz clic aquí'))
  await clic(ls[y]!.indexOf('Haz clic aquí') + 1, y)
  await escribir('SELECT * FROM dbo.clientes')
  await ui.key({ key: 'e', ctrl: true } as never)
  ls = await lineas()
  /** Doble clic en la celda que muestra `valor`. */
  const dobleClic = async (valor: string) => {
    const ls = await lineas()
    const y = ls.findIndex(l => new RegExp(`\\b${valor}\\b`).test(l) && /[│┃]\s+\d+\s/.test(l))
    expect(y).toBeGreaterThan(-1)
    const x = ls[y]!.indexOf(valor) + 1
    await clic(x, y)
    await clic(x, y)
    return lineas()
  }
  return { ui, lineas, clic, escribir, dobleClic }
}

test('doble clic, escribir, Enter muestra el UPDATE y el segundo Enter lo guarda', async ($, on) => {
  const llamadas = puente(on)
  const p = await preparar($)
  let ls = await p.dobleClic('Ana')
  let todo = ls.join('\n')
  expect(todo).toContain('[dbo].[clientes] · nombre · fila 1')
  expect(todo).toContain('Enter: ver el UPDATE')

  for (let i = 0; i < 3; i++) await p.ui.key({ key: 'backspace' } as never)
  await p.escribir('Beatriz')
  await p.ui.key({ key: 'return' } as never)
  ls = await p.lineas()
  todo = ls.join('\n')
  expect(todo).toContain("¿Guardar? UPDATE [dbo].[clientes] SET [nombre] = N'Beatriz' WHERE [id] = 1")
  expect(llamadas.filter(l => l.ruta === '/update').map(l => l.cuerpo.dryRun)).toEqual([true])

  await p.ui.key({ key: 'return' } as never)
  ls = await p.lineas()
  todo = ls.join('\n')
  const real = llamadas.filter(l => l.ruta === '/update' && !l.cuerpo.dryRun)
  expect(real).toHaveLength(1)
  expect(real[0]!.cuerpo).toMatchObject({ column: 'nombre', value: 'Beatriz', original: 'Ana', key: [{ column: 'id', value: 1 }], table: { schema: 'dbo', name: 'clientes' } })
  expect(todo).toContain('Beatriz')
  expect(todo).not.toContain('¿Guardar?')
  expect(todo).not.toContain('· nombre · fila 1')
  await p.ui.unmount()
})

test('si el UPDATE falla, el error del motor se ve entero y lo escrito se conserva', async ($, on) => {
  const error = "Conversion failed when converting the nvarchar value 'abc' to data type decimal."
  puente(on, { errorUpdate: error })
  const p = await preparar($)
  await p.dobleClic('10.50')
  for (let i = 0; i < 5; i++) await p.ui.key({ key: 'backspace' } as never)
  await p.escribir('abc')
  await p.ui.key({ key: 'return' } as never)
  await p.ui.key({ key: 'return' } as never)
  const todo = (await p.lineas()).join('\n')
  expect(todo).toContain('✗ ' + error)
  expect(todo).toContain('[dbo].[clientes] · saldo · fila 1')
  expect(todo).toContain('abc')
  expect(todo).toContain(' Guardar ')
  await p.ui.unmount()
})

test('en solo lectura, o si la consulta no es editable, el recuadro dice por qué', async ($, on) => {
  puente(on, { soloLectura: true })
  const p = await preparar($)
  let todo = (await p.dobleClic('Ana')).join('\n')
  expect(todo).toContain('nombre: no se puede editar')
  expect(todo).toContain('es de solo lectura')
  await p.ui.key({ key: 'return' } as never)
  todo = (await p.lineas()).join('\n')
  expect(todo).not.toContain('no se puede editar')
  await p.ui.unmount()
})

test('una consulta que el puente no deja editar muestra su motivo', async ($, on) => {
  puente(on, { editable: { editable: false, reason: 'La consulta combina varias tablas: para editar, consulta una sola.' } })
  const p = await preparar($)
  const todo = (await p.dobleClic('Ana')).join('\n')
  expect(todo).toContain('combina varias tablas')
  await p.ui.unmount()
})

test('la columna de la clave (identidad) no se edita; un clic fuera cancela', async ($, on) => {
  const llamadas = puente(on)
  const p = await preparar($)
  let ls = await p.lineas()
  const y = ls.findIndex(l => /│\s+1\s+1\s+Ana/.test(l))
  expect(y).toBeGreaterThan(-1)
  const x = ls[y]!.search(/1\s+Ana/) + 1
  await p.clic(x, y)
  await p.clic(x, y)
  let todo = (await p.lineas()).join('\n')
  expect(todo).toContain('«id» no se puede editar')
  await p.ui.key({ key: 'return' } as never)

  await p.dobleClic('Luis')
  todo = (await p.lineas()).join('\n')
  expect(todo).toContain('· nombre · fila 2')
  ls = await p.lineas()
  await p.clic(5, 3) // el explorador
  todo = (await p.lineas()).join('\n')
  expect(todo).not.toContain('· nombre · fila 2')
  expect(llamadas.filter(l => l.ruta === '/update')).toHaveLength(0)
  await p.ui.unmount()
})
