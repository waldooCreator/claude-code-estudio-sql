import { expect, test } from 'claude-code/testing'

// Con la vista «Mensajes» elegida, un panel de pocas columnas dejaba el dibujo
// en un ciclo sin fin: la terminal lo descartaba y el panel quedaba vacío.

const LOCAL = { id: 'c1', nombre: 'Local', motor: 'sqlite', host: '/tmp/x.db', puerto: '', usuario: '', base: '', color: '#0078d4', soloLectura: false, ssh: null }

test('panel angosto con la vista Mensajes', async ($, on) => {
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Linux x86_64\n' : '', stderr: '' } }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('process.spawn', async function* () { yield { stream: 'stdout', text: '{"socket":"/tmp/p.sock"}\n' }; return { value: { code: 0, signal: null } } } as never)
  on('store.get', ($, e) => ({ value: e.key === 'conexiones' ? [LOCAL] : undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__estudio-sql__consultar' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ results: [], messages: [{ text: 'no such table: asistente_bitacora', error: true }], ms: 3, failed: true }) } }) as never)
  await $.session.start({ cwd: '/tmp', surface: 'terminal' } as never)
  const ui = await $.ui.mount({ plugin: 'estudio-sql', surface: 'terminal', component: 'Pane', requestId: 'estudio-sql', props: { title: 'Estudio SQL', isFocused: true, bodyColumns: 120, placement: 'dock' } as never, viewport: { columns: 120, rows: 40 } })
  await ui.resize({ columns: 120, rows: 40 } as never)
  await $.tool.call({ tool: 'mcp__estudio-sql__consultar', conexion: 'Local', sql: 'SELECT canal FROM asistente_bitacora', titulo: 'mal' } as never)
  await ui.advance(50)
  // La pestaña «Mensajes» queda elegida, como cuando uno lee el error.
  const lineas = JSON.stringify(await ui.drawn({ in: 'estudio' } as never))
  expect(lineas).toContain('Mensajes')
  const arbol = (await ui.drawn({ in: 'estudio' } as never)) as { children?: unknown[] }
  const texto = (n: unknown): string => typeof n === 'string' ? n : n && typeof n === 'object' ? ((n as { children?: unknown[] }).children ?? []).map(texto).join('') : ''
  const filas = (arbol.children ?? []).map(texto)
  const y = filas.findIndex(t => / Mensajes /.test(t))
  await ui.pointer({ type: 'down', x: filas[y]!.indexOf('Mensajes') + 1, y, button: 'left' })
  expect(JSON.stringify(await ui.drawn({ in: 'estudio' } as never))).toContain('no such table')
  for (const cols of [5, 3, 1]) {
    await ui.resize({ columns: cols, rows: 40 } as never)
    expect(await ui.drawn({ in: 'estudio' } as never)).toBeDefined()
  }
  await ui.resize({ columns: 120, rows: 40 } as never)
  expect(JSON.stringify(await ui.drawn({ in: 'estudio' } as never))).toContain('no such table')
  await ui.unmount()
})
