import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Conexion, Encargo, Esquema, Modelo, Pedido, Prueba, Resultado } from '../types'

const PANEL = 'estudio-sql'
const MAX_FILAS_PANEL = 500 // las que viajan al panel; el resto se queda aquí para copiar
const MAX_TEXTO_CELDA = 200

const VACIO: Modelo = {
  conexiones: [],
  esquemas: {},
  resultados: {},
  prueba: null,
  puente: { listo: false },
  tema: 'claro',
  aviso: null,
  ampliado: false,
  pegado: null,
  encargo: null,
}
const modelo = atom({ plugin: 'estudio-sql', key: 'modelo' } as const, VACIO)

let columnasTerminal = 0

// ── Portapapeles del sistema. Muchas terminales (Ptyxis/VTE entre ellas) no
// dejan copiar por la secuencia OSC 52, así que primero se usan las
// herramientas del sistema y $.ui.copy queda de respaldo.

const COPIAR: string[][] = [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input'], ['pbcopy'], ['clip.exe'], ['clip']]
const PEGAR: string[][] = [['wl-paste', '--no-newline'], ['xclip', '-selection', 'clipboard', '-o'], ['xsel', '--clipboard', '--output'], ['pbpaste'], ['powershell.exe', '-NoProfile', '-Command', 'Get-Clipboard -Raw'], ['powershell', '-NoProfile', '-Command', 'Get-Clipboard -Raw']]

async function copiarAlSistema($: EngineInterface, texto: string, superficie: string): Promise<boolean> {
  for (const argv of COPIAR) {
    try {
      const r = await $.process.run(argv, { stdin: texto, timeoutMs: 5000 })
      if (r.exitCode === 0) return true
    } catch {
      // esa herramienta no existe aquí: la siguiente
    }
  }
  try {
    return (await $.ui.copy({ text: texto, surface: superficie as never })).isCopied
  } catch {
    return false
  }
}

async function leerDelSistema($: EngineInterface): Promise<string | null> {
  for (const argv of PEGAR) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 })
      if (r.exitCode === 0) return r.stdout.replace(/\r\n/g, '\n')
    } catch {
      // la siguiente
    }
  }
  return null
}

// Resultados completos por pestaña (el panel recibe una versión recortada).
const completos = new Map<string, { columnas: string[]; filas: unknown[][] }[]>()
let socket: string | null = null
let arrancando: Promise<string> | null = null

// ── El puente

async function binario($: EngineInterface): Promise<string> {
  let os = 'windows'
  let arch = 'amd64'
  try {
    const r = await $.process.run(['uname', '-s', '-m'], { timeoutMs: 5000 })
    const [s = '', m = ''] = r.stdout.trim().toLowerCase().split(/\s+/)
    os = s.startsWith('darwin') ? 'darwin' : s.startsWith('linux') ? 'linux' : 'windows'
    arch = m === 'arm64' || m === 'aarch64' ? 'arm64' : 'amd64'
  } catch {
    // sin uname: Windows
  }
  return `${$.plugin.root}/bin/puente-${os}-${arch}${os === 'windows' ? '.exe' : ''}`
}

function arrancarPuente($: EngineInterface): Promise<string> {
  if (socket) return Promise.resolve(socket)
  if (arrancando) return arrancando
  arrancando = (async () => {
    const bin = await binario($)
    if (!(await $.fs.exists(bin))) throw new Error(`No encontré el puente para este sistema (${bin}).`)
    const hijo = $.process.spawn({ argv: [bin] })
    let primera = ''
    const listo = new Promise<string>((resolve, reject) => {
      void (async () => {
        try {
          for await (const trozo of hijo) {
            if (!('text' in trozo) || trozo.stream !== 'stdout' || socket) continue
            primera += trozo.text
            const fin = primera.indexOf('\n')
            if (fin < 0) continue
            const dato = JSON.parse(primera.slice(0, fin)) as { socket?: string; error?: string }
            if (dato.socket) resolve(dato.socket)
            else reject(new Error(dato.error ?? 'El puente no arrancó.'))
          }
        } catch (err) {
          reject(err)
        }
        socket = null
        arrancando = null
        await update($, modelo, m => ({ ...m, puente: { listo: false, error: 'El puente se detuvo; se reinicia con la próxima consulta.' } }))
        reject(new Error('El puente se cerró antes de arrancar.'))
      })()
    })
    socket = await listo
    await update($, modelo, m => ({ ...m, puente: { listo: true } }))
    return socket
  })()
  arrancando.catch(async err => {
    arrancando = null
    await update($, modelo, m => ({ ...m, puente: { listo: false, error: String(err instanceof Error ? err.message : err) } }))
  })
  return arrancando
}

async function puente<T>($: EngineInterface, ruta: string, cuerpo: unknown): Promise<T> {
  const sock = await arrancarPuente($)
  const r = await $.http.fetch(`http://puente${ruta}`, { method: 'POST', body: JSON.stringify(cuerpo), socketPath: sock })
  const dato = JSON.parse(r.text) as T & { error?: string }
  if (dato.error) throw new Error(dato.error)
  return dato
}

const alPuente = (c: Conexion, clave?: string) => ({
  id: c.id,
  engine: c.motor,
  host: c.host,
  port: c.puerto,
  user: c.usuario,
  database: c.base,
  readOnly: c.soloLectura,
  ...(clave ? { password: clave } : {}),
  ...(c.ssh && c.ssh.host ? { ssh: { host: c.ssh.host, key: c.ssh.llave } } : {}),
})

const mensaje = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ── Lo que se guarda entre sesiones (sin contraseñas)

async function guardar($: EngineInterface): Promise<void> {
  const m = await read($, modelo)
  await $.store.set('conexiones', m.conexiones)
  await $.store.set('tema', m.tema)
}

// ── Acciones que pide el panel

type PuenteResultado = {
  results: { columns: string[]; types: string[]; rows: unknown[][]; truncated: boolean }[]
  messages: { text: string; error?: boolean }[]
  ms: number
  failed: boolean
}

const NUMERICOS = /int|dec|num|real|float|double|money|serial/

function aTexto(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  return s.length > MAX_TEXTO_CELDA ? s.slice(0, MAX_TEXTO_CELDA) + '…' : s
}

/** Ejecuta la consulta de una pestaña; `soloLectura` la obliga aunque la conexión no lo sea. */
async function ejecutar($: EngineInterface, p: Extract<Pedido, { t: 'ejecutar' }>, soloLectura = false): Promise<void> {
  const m = await read($, modelo)
  const conexion = m.conexiones.find(c => c.id === p.conexion)
  if (!conexion) return
  const corriendo: Resultado = { estado: 'corriendo', conexion: p.conexion, base: p.base, conjuntos: [], mensajes: [] }
  await update($, modelo, x => ({ ...x, resultados: { ...x.resultados, [p.pestana]: corriendo } }))
  let fin: Resultado
  try {
    const r = await puente<PuenteResultado>($, '/query', {
      queryId: p.pestana,
      conn: alPuente(soloLectura ? { ...conexion, soloLectura: true } : conexion),
      database: p.base,
      sql: p.sql,
      maxRows: 5000,
    })
    completos.set(p.pestana, r.results.map(rs => ({ columnas: rs.columns, filas: rs.rows })))
    fin = {
      estado: 'listo',
      conexion: p.conexion,
      base: p.base,
      ms: r.ms,
      fallo: r.failed,
      conjuntos: r.results.map(rs => ({
        columnas: rs.columns,
        numericas: rs.columns.map((_, i) => NUMERICOS.test(rs.types?.[i] ?? '') || (rs.rows.length > 0 && rs.rows.every(f => f[i] === null || typeof f[i] === 'number'))),
        filas: rs.rows.slice(0, MAX_FILAS_PANEL).map(f => f.map(aTexto)),
        total: rs.rows.length,
        recortado: rs.truncated || rs.rows.length > MAX_FILAS_PANEL,
      })),
      mensajes: r.messages.map(x => ({ texto: x.text, ...(x.error ? { error: true } : {}) })),
    }
  } catch (err) {
    fin = { estado: 'listo', conexion: p.conexion, base: p.base, fallo: true, error: mensaje(err), conjuntos: [], mensajes: [{ texto: mensaje(err), error: true }] }
  }
  await update($, modelo, x => ({ ...x, resultados: { ...x.resultados, [p.pestana]: fin } }))
}

async function cargarEsquema($: EngineInterface, idConexion: string, base?: string): Promise<void> {
  const m = await read($, modelo)
  const conexion = m.conexiones.find(c => c.id === idConexion)
  if (!conexion) return
  const poner = (fn: (e: Esquema) => Esquema) =>
    update($, modelo, x => ({ ...x, esquemas: { ...x.esquemas, [idConexion]: fn(x.esquemas[idConexion] ?? { objetos: {} }) } }))
  if (!base) {
    await poner(e => ({ ...e, cargando: true, error: undefined }))
    try {
      const r = await puente<{ databases: string[] }>($, '/schema', { conn: alPuente(conexion) })
      await poner(e => ({ ...e, cargando: false, bases: r.databases }))
    } catch (err) {
      await poner(e => ({ ...e, cargando: false, error: mensaje(err) }))
    }
    return
  }
  await poner(e => ({ ...e, objetos: { ...e.objetos, [base]: 'cargando' } }))
  try {
    const r = await puente<{ objects: Esquema['objetos'][string] }>($, '/schema', { conn: alPuente(conexion), database: base })
    await poner(e => ({ ...e, objetos: { ...e.objetos, [base]: r.objects } }))
  } catch (err) {
    await poner(e => ({ ...e, objetos: { ...e.objetos, [base]: { error: mensaje(err) } } }))
  }
}

function comoTabla(columnas: string[], filas: unknown[][], sep: '\t' | ','): string {
  const celda = (v: unknown) => {
    const s = v === null || v === undefined ? (sep === ',' ? '' : 'NULL') : String(v)
    return sep === ',' && /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s.replaceAll('\t', ' ').replaceAll('\n', ' ')
  }
  return [columnas.map(celda).join(sep), ...filas.map(f => f.map(celda).join(sep))].join('\n')
}

function comoMarkdown(columnas: string[], filas: unknown[][]): string {
  const celda = (v: unknown) => (v === null || v === undefined ? 'NULL' : String(v)).replaceAll('|', '\\|').replaceAll('\n', ' ')
  return [
    `| ${columnas.map(celda).join(' | ')} |`,
    `| ${columnas.map(() => '---').join(' | ')} |`,
    ...filas.map(f => `| ${f.map(celda).join(' | ')} |`),
  ].join('\n')
}

async function atender($: EngineInterface, p: Pedido, superficie: 'terminal' | string): Promise<void> {
  switch (p.t) {
    case 'ejecutar':
      return ejecutar($, p)
    case 'cancelar':
      await puente($, '/cancel', { queryId: p.pestana }).catch(() => undefined)
      return
    case 'esquema':
      return cargarEsquema($, p.conexion, p.base)
    case 'probar': {
      const poner = (prueba: Prueba) => update($, modelo, m => ({ ...m, prueba }))
      await poner({ estado: 'probando', texto: 'Probando la conexión…' })
      try {
        const r = await puente<{ version: string; ms: number }>($, '/test', { conn: alPuente(p.conexion, p.clave) })
        const via = p.conexion.ssh?.host ? ' por SSH' : ''
        await poner({ estado: 'ok', texto: `✓ Conexión correcta${via} · versión ${r.version || '?'} · ${r.ms} ms` })
      } catch (err) {
        await poner({ estado: 'error', texto: '✗ ' + mensaje(err) })
      }
      return
    }
    case 'cerrarPrueba':
      await update($, modelo, m => ({ ...m, prueba: null }))
      return
    case 'guardar': {
      if (p.clave !== null) {
        try {
          await puente($, '/secret/set', { id: p.conexion.id, password: p.clave })
        } catch (err) {
          await update($, modelo, m => ({ ...m, aviso: mensaje(err) }))
        }
      }
      await puente($, '/close', { id: p.conexion.id }).catch(() => undefined)
      await update($, modelo, m => {
        const existe = m.conexiones.some(c => c.id === p.conexion.id)
        const conexiones = existe ? m.conexiones.map(c => (c.id === p.conexion.id ? p.conexion : c)) : [...m.conexiones, p.conexion]
        const { [p.conexion.id]: _viejo, ...esquemas } = m.esquemas
        return { ...m, conexiones, esquemas, prueba: null }
      })
      await guardar($)
      return cargarEsquema($, p.conexion.id)
    }
    case 'borrar': {
      await puente($, '/secret/delete', { id: p.conexion }).catch(() => undefined)
      await update($, modelo, m => {
        const { [p.conexion]: _viejo, ...esquemas } = m.esquemas
        return { ...m, conexiones: m.conexiones.filter(c => c.id !== p.conexion), esquemas }
      })
      await guardar($)
      return
    }
    case 'tema':
      await update($, modelo, m => ({ ...m, tema: p.tema }))
      await guardar($)
      return
    case 'copiar': {
      const rs = completos.get(p.pestana)?.[0]
      if (!rs) return
      const ok = await copiarAlSistema($, comoTabla(rs.columnas, rs.filas, p.formato === 'csv' ? ',' : '\t'), superficie)
      $.ui.toast(ok ? `Copiadas ${rs.filas.length} filas${p.formato === 'csv' ? ' como CSV' : ''}.` : NO_COPIA)
      return
    }
    case 'copiarParte': {
      const rs = completos.get(p.pestana)?.[p.conjunto]
      if (!rs) return
      const v = (x: unknown) => (x === null || x === undefined ? 'NULL' : String(x))
      let texto: string
      let que: string
      if (p.fila !== null && p.columna !== null) {
        texto = v(rs.filas[p.fila]?.[p.columna])
        que = 'Celda copiada.'
      } else if (p.fila !== null) {
        texto = comoTabla(rs.columnas, [rs.filas[p.fila] ?? []], '\t')
        que = 'Fila copiada, con encabezados.'
      } else if (p.columna !== null) {
        texto = rs.filas.map(f => v(f[p.columna!])).join('\n')
        que = `Columna «${rs.columnas[p.columna]}» copiada (${rs.filas.length} valores).`
      } else {
        texto = comoTabla(rs.columnas, rs.filas, '\t')
        que = `Copiadas ${rs.filas.length} filas con encabezados.`
      }
      $.ui.toast((await copiarAlSistema($, texto, superficie)) ? que : NO_COPIA)
      return
    }
    case 'copiarTexto': {
      $.ui.toast((await copiarAlSistema($, p.texto, superficie)) ? p.que : NO_COPIA)
      return
    }
    case 'pegar': {
      const texto = await leerDelSistema($)
      if (texto === null) {
        $.ui.toast('No pude leer el portapapeles. Pega con Ctrl+Shift+V (el pegado de la terminal).')
        return
      }
      await update($, modelo, m => ({ ...m, pegado: { n: (m.pegado?.n ?? 0) + 1, texto } }))
      return
    }
    case 'ampliar': {
      const m = await update($, modelo, x => ({ ...x, ampliado: !x.ampliado }))
      await abrir($, false, m.ampliado)
      return
    }
    case 'claude': {
      const rs = completos.get(p.pestana)?.[0]
      const m = await read($, modelo)
      const res = m.resultados[p.pestana]
      const conexion = m.conexiones.find(c => c.id === res?.conexion)
      const partes = [`Resultado de esta consulta en ${conexion ? `${conexion.nombre} (${conexion.motor})` : 'la base'}${res?.base ? `, base ${res.base}` : ''}:`, '```sql', p.sql.trim(), '```']
      if (rs) {
        const muestra = rs.filas.slice(0, 50)
        partes.push(comoMarkdown(rs.columnas, muestra))
        if (rs.filas.length > muestra.length) partes.push(`(se muestran 50 de ${rs.filas.length} filas)`)
      } else if (res?.mensajes.length) {
        partes.push(res.mensajes.map(x => x.texto).join('\n'))
      }
      await $.prompt.fill({ text: partes.join('\n') + '\n\n', mode: 'append' })
      $.ui.toast('El resultado quedó en tu prompt: agrega tu pregunta y envíalo.')
      return
    }
  }
}

// ── Consultas que pide Claude: se abren en el panel y corren a la vista

const HERRAMIENTA = 'consultar'
const FILAS_CLAUDE = 100
const MAX_TEXTO_CLAUDE = 60_000

type PedidoClaude = { conexion?: unknown; base?: unknown; sql?: unknown; titulo?: unknown; filas?: unknown }

const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

function listaConexiones(m: Modelo): string {
  if (m.conexiones.length === 0) return 'ninguna (la persona debe crear una en /sql)'
  return m.conexiones
    .map(c => {
      const bases = m.esquemas[c.id]?.bases
      return `«${c.nombre}» (${c.motor}${c.base ? `, base ${c.base}` : ''}${bases?.length ? `; bases: ${bases.join(', ')}` : ''})`
    })
    .join('; ')
}

async function consultarAVista($: EngineInterface, a: PedidoClaude, signal?: AbortSignal): Promise<string> {
  const sql = texto(a.sql)
  if (!sql) return 'Falta la consulta (sql).'
  let m = await read($, modelo)
  const buscado = texto(a.conexion).toLowerCase()
  const buscar = (lista: Conexion[]) => lista.find(c => c.nombre.toLowerCase() === buscado || c.id === a.conexion)
  let conexion = buscar(m.conexiones)
  if (!conexion) {
    // Otra sesión (o la persona a mano) pudo guardarla después de abrir esta: se relee la lista guardada.
    const guardadas = ((await $.store.get('conexiones')) as Conexion[] | undefined) ?? []
    const nuevas = guardadas.filter(g => !m.conexiones.some(c => c.id === g.id))
    if (nuevas.length) m = await update($, modelo, x => ({ ...x, conexiones: [...x.conexiones, ...nuevas] }))
    conexion = buscar(m.conexiones)
  }
  if (!conexion) return `No hay una conexión llamada «${texto(a.conexion)}». Conexiones guardadas: ${listaConexiones(m)}.`
  const base = texto(a.base) || conexion.base
  const n = (m.encargo?.n ?? 0) + 1
  const titulo = (texto(a.titulo) || `claude${n}`).replace(/\.sql$/i, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 24)
  const pestana: Encargo = { id: `claude-${n}-${Date.now()}`, nombre: `${titulo}.sql`, conexion: conexion.id, base, sql }
  await update($, modelo, x => ({ ...x, encargo: { n, pestana } }))
  let puesto = (await $.ui.panes()).some(p => p.id === PANEL)
  if (!puesto) puesto = await abrir($, false, m.ampliado)
  const cancelar = () => void puente($, '/cancel', { queryId: pestana.id }).catch(() => undefined)
  signal?.addEventListener('abort', cancelar)
  try {
    await ejecutar($, { t: 'ejecutar', pestana: pestana.id, conexion: conexion.id, base, sql }, true)
  } finally {
    signal?.removeEventListener('abort', cancelar)
  }
  const res = (await read($, modelo)).resultados[pestana.id]
  const filas = Math.max(1, Math.min(1000, typeof a.filas === 'number' ? Math.floor(a.filas) : FILAS_CLAUDE))
  const dondeSeVe = puesto ? `a la vista en Estudio SQL, pestaña «${pestana.nombre}»` : `en Estudio SQL (el panel se abre cuando la terminal tenga espacio; pestaña «${pestana.nombre}»)`
  const segundos = res?.ms !== undefined ? `, ${(res.ms / 1000).toFixed(2).replace('.', ',')} s` : ''
  const partes = [`Consulta ejecutada ${dondeSeVe}: ${conexion.nombre} (${conexion.motor})${base ? `, base ${base}` : ''}${segundos}, solo lectura.`]
  if (!res || res.fallo) partes.push(`La consulta falló: ${res?.error ?? res?.mensajes.filter(x => x.error).map(x => x.texto).join(' / ') ?? 'sin respuesta del puente'}`)
  let usado = partes[0]!.length
  ;(completos.get(pestana.id) ?? []).forEach((rs, i) => {
    const muestra = rs.filas.slice(0, filas).map(f => f.map(aTextoCompleto))
    let tabla = comoMarkdown(rs.columnas, muestra)
    let mostradas = muestra.length
    while (usado + tabla.length > MAX_TEXTO_CLAUDE && mostradas > 1) {
      mostradas = Math.max(1, Math.floor(mostradas / 2))
      tabla = comoMarkdown(rs.columnas, muestra.slice(0, mostradas))
    }
    const cuenta = rs.filas.length === mostradas ? `${rs.filas.length} ${rs.filas.length === 1 ? 'fila' : 'filas'}` : `se muestran ${mostradas} de ${rs.filas.length} filas`
    partes.push(`Conjunto ${i + 1} (${cuenta}):`, tabla)
    usado += tabla.length
  })
  const mensajes = res?.mensajes.filter(x => !x.error).map(x => x.texto) ?? []
  if (mensajes.length) partes.push('Mensajes:', mensajes.join('\n'))
  return partes.join('\n\n')
}

/** Para Claude, el valor entero (el panel lo corta); los objetos como JSON. */
const aTextoCompleto = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)

// ── Registro

const NO_COPIA = 'No pude copiar: instala wl-clipboard (Wayland) o xclip (X11).'

/** Ancho pedido al panel: normal, o casi toda la terminal dejando un poco de conversación. */
function anchoPanel(ampliado: boolean): number {
  if (!ampliado) return 120
  return columnasTerminal > 0 ? Math.max(120, columnasTerminal - 24) : 400
}

async function abrir($: EngineInterface, pedido: boolean, ampliado = false): Promise<boolean> {
  const r = await $.ui.open({ id: PANEL, title: 'Estudio SQL', ...(pedido ? { focus: true as const } : {}), columns: anchoPanel(ampliado) })
  return r.isPlaced
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const conexiones = ((await $.store.get('conexiones')) as Conexion[] | undefined) ?? []
    const tema = ((await $.store.get('tema')) as Modelo['tema'] | undefined) ?? 'claro'
    await update($, modelo, m => ({ ...m, conexiones, tema }))
    await $.command.register({ name: 'sql', description: 'Abre Estudio SQL: tus conexiones, el editor y los resultados' })
    await $.tool.register({
      name: HERRAMIENTA,
      description:
        'Ejecuta una consulta SQL de solo lectura en una conexión guardada de Estudio SQL, a la vista de la persona: ' +
        'abre el panel /sql, pone la consulta en una pestaña nueva, la ejecuta y devuelve el resultado. ' +
        'Úsala siempre que necesites consultar una base de datos de la persona, en lugar de un cliente por la terminal. ' +
        'Solo lectura: se rechaza INSERT, UPDATE, DELETE, DROP, EXEC y parecidos. ' +
        'Si no sabes el nombre de la conexión, llámala con uno cualquiera y la respuesta trae la lista.',
      inputSchema: {
        type: 'object',
        properties: {
          conexion: { type: 'string', description: 'Nombre de la conexión como se ve en el explorador de /sql (no distingue mayúsculas).' },
          base: { type: 'string', description: 'Base de datos donde corre; vacío = la predeterminada de la conexión.' },
          sql: { type: 'string', description: 'La consulta, de solo lectura.' },
          titulo: { type: 'string', description: 'Nombre corto de la pestaña, p. ej. «ventas-octubre».' },
          filas: { type: 'integer', minimum: 1, maximum: 1000, description: `Máximo de filas por conjunto en la respuesta (por defecto ${FILAS_CLAUDE}); el panel muestra hasta ${MAX_FILAS_PANEL}.` },
        },
        required: ['conexion', 'sql'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  // El nombre completo de HERRAMIENTA; todavía no está en los tipos de las herramientas conocidas.
  on('tool.call', { tool: 'mcp__estudio-sql__consultar' as never }, async ($, e, next) => ({
    result: await consultarAVista($, e as unknown as PedidoClaude, next.signal),
  })).catch(() => ({ result: 'Estudio SQL no pudo ejecutar la consulta: el mod falló. Abre /sql y revisa la barra de estado.' }))

  on('command.run', { command: 'sql' }, async $ => {
    const abierto = (await $.ui.panes()).some(p => p.id === PANEL)
    if (abierto) {
      await $.ui.close({ id: PANEL })
      return { text: 'Estudio SQL cerrado.' }
    }
    void arrancarPuente($).catch(() => undefined)
    const puesto = await abrir($, true, (await read($, modelo)).ampliado)
    return { text: puesto ? 'Estudio SQL abierto.' : 'Estudio SQL se abrirá cuando la terminal tenga más espacio (pantalla completa, 110 columnas o más).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const els = $.ui.resolve(e)
    if (!('Client' in els)) return <els.Text dimColor>Estudio SQL se usa desde la terminal.</els.Text>
    const { Client } = els
    if (e.viewport && e.viewport.columns > 0) columnasTerminal = e.viewport.columns
    const m = await read($, modelo)
    // El tamaño exacto del cuerpo del panel: así el dibujo lo llena entero.
    const filas = Math.max(12, e.props.scroll?.bodyRows ?? 30)
    const columnas = Math.max(40, e.props.bodyColumns || 100)
    return <Client key="estudio" module="./estudio.tsx" props={m} width={columnas} height={filas} />
  })

  on('ui.message', { requestId: PANEL }, async ($, e) => {
    const p = e.data as Pedido
    if (p && typeof p === 'object' && 't' in p) void atender($, p, e.surface).catch(async err => {
      await update($, modelo, m => ({ ...m, aviso: mensaje(err) }))
    })
    return {}
  })
}
