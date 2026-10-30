import type { ClientKeyEvent, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { Conexion, Modelo, Motor, Objeto, Pedido } from '../types'
import { CLARO, Lienzo, OSCURO, colorear, recortar } from './dibujo'
import type { Tema } from './dibujo'

type Pos = { r: number; c: number }
/** `ancla`: el otro extremo de la selección, si hay una. */
type Pestana = { id: string; nombre: string; conexion: string; base: string; sql: string; cur: Pos; ancla?: Pos | null }

const aOffset = (lin: string[], p: Pos) => lin.slice(0, p.r).reduce((a, l) => a + l.length + 1, 0) + p.c
function aPos(texto: string, off: number): Pos {
  const antes = texto.slice(0, off).split('\n')
  return { r: antes.length - 1, c: antes[antes.length - 1]!.length }
}
/** La selección como [desde, hasta) en el texto, o null si está vacía. */
function seleccion(p: Pestana): [number, number] | null {
  if (!p.ancla) return null
  const lin = p.sql.split('\n')
  const a = aOffset(lin, p.ancla)
  const b = aOffset(lin, p.cur)
  return a === b ? null : [Math.min(a, b), Math.max(a, b)]
}
/** Pone `texto` en lugar de la selección (o en el cursor) y deja el cursor detrás. */
function insertar(p: Pestana, texto: string): Pestana {
  const lin = p.sql.split('\n')
  const [a, b] = seleccion(p) ?? [aOffset(lin, p.cur), aOffset(lin, p.cur)]
  const sql = p.sql.slice(0, a) + texto + p.sql.slice(b)
  return { ...p, sql, cur: aPos(sql, a + texto.length), ancla: null }
}
type Dialogo = {
  id: string | null // null: conexión nueva
  motor: Motor
  campos: Record<string, string>
  campo: string
  ssh: boolean
  soloLectura: boolean
  color: number
  claveTocada: boolean
}
type Menu = { x: number; y: number; items: { label: string; accion: () => void }[] }
type Estado = {
  pestanas: Pestana[]
  pestana: number
  abiertos: Record<string, boolean>
  sel: string | null
  hover: string | null
  foco: 'editor' | 'resultados' | null
  dlg: Dialogo | null
  menu: Menu | null
  vista: 'res' | 'msg'
  conjunto: number
  fila: number | null
  desdeFila: number
  desdeCol: number
  parpadeo: boolean
  n: number
  arrastrando: boolean
  celda: { f: number; c: number } | null
  /** El último pegado ya insertado (Modelo.pegado.n) y dónde va el siguiente. */
  pegadoN: number
  /** La última consulta de Claude ya abierta en una pestaña (Modelo.encargo.n). */
  encargoN: number
  /** Qué divisor se está arrastrando: el del explorador (v) o el de los resultados (h). */
  arrastre: 'v' | 'h' | null
  /** Ancho del explorador y alto del editor elegidos al arrastrar; null = automático. */
  anchoExp: number | null
  altoEditor: number | null
}

const MOTORES: [Motor, string, string][] = [
  ['mssql', 'SQL Server', '1433'],
  ['postgres', 'PostgreSQL', '5432'],
  ['mysql', 'MySQL / MariaDB', '3306'],
  ['sqlite', 'SQLite', ''],
]
const COLORES = ['#c42b1c', '#ca5010', '#2f7d32', '#0078d4', '#8764b8', '#8a6d00']
const nombreMotor = (m: Motor) => MOTORES.find(x => x[0] === m)?.[1] ?? m
// Las únicas teclas que la terminal entrega con nombre; el espacio llega como
// «space» y todo lo demás como el texto tecleado o pegado. Escape no llega.
const ESPECIALES = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'return', 'tab', 'backspace', 'delete'])

/** Lo que significa una tecla: una tecla con nombre, texto a insertar, o nada. */
function leerTecla(ev: ClientKeyEvent): { tecla: string } | { texto: string } | null {
  const k = ev.key
  if (k === 'space') return { texto: ' ' }
  if (ESPECIALES.has(k)) return { tecla: k }
  // F5 y compañía llegan como secuencias crudas (\x1b[15~, OP…): F5 ejecuta, el resto se ignora.
  if (/^\x1b?\[15~$/.test(k)) return { tecla: 'f5' }
  if (/^\x1b?(\[[\d;]*[~A-Za-z]|O[A-Z])$/.test(k)) return null
  const texto = k.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  return texto ? { texto } : null
}
const ICONO_BASE =[' ▄▄▄▄ ', '█▄▄▄▄█', '█▄▄▄▄█', ' ▀▀▀▀ ']

function inicial(m: Modelo): Estado {
  const c = m.conexiones[0]
  return {
    pestanas: [{ id: 'q1', nombre: 'consulta1.sql', conexion: c?.id ?? '', base: c?.base ?? '', sql: '', cur: { r: 0, c: 0 } }],
    pestana: 0,
    abiertos: {},
    sel: null,
    hover: null,
    foco: null,
    dlg: null,
    menu: null,
    vista: 'res',
    conjunto: 0,
    fila: null,
    desdeFila: 0,
    desdeCol: 0,
    parpadeo: true,
    n: 1,
    arrastrando: false,
    celda: null,
    pegadoN: m.pegado?.n ?? 0,
    encargoN: 0,
    arrastre: null,
    anchoExp: null,
    altoEditor: null,
  }
}

/** Lo que la barra de estado dice al pasar el puntero por los divisores. */
const AYUDAS: Record<string, string> = {
  divV: '⇔ Arrastra este borde para cambiar el ancho del explorador',
  divH: '⇕ Arrastra esta barra para repartir el alto entre la consulta y los resultados',
  masRes: '▲ Más espacio para los resultados',
  masEd: '▼ Más espacio para la consulta',
}
const limitar = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))
/** Pestañas de Claude que se conservan; las más viejas se cierran solas. */
const MAX_PESTANAS_CLAUDE = 4

function consultaDeTabla(motor: Motor, o: Objeto): string {
  const q = (s: string) => (motor === 'mssql' ? `[${s}]` : motor === 'mysql' ? `\`${s}\`` : `"${s}"`)
  const nombre = o.schema ? `${q(o.schema)}.${q(o.name)}` : q(o.name)
  return motor === 'mssql'
    ? `-- Primeras 1000 filas de ${o.schema ? o.schema + '.' : ''}${o.name}\nSELECT TOP (1000) *\nFROM ${nombre};`
    : `-- Primeras 1000 filas de ${o.schema ? o.schema + '.' : ''}${o.name}\nSELECT *\nFROM ${nombre}\nLIMIT 1000;`
}

const Estudio = (m: Modelo, surface: ClientSurface<Estado>) => {
  const { Box, Text } = surface.elements
  if (surface.state === undefined) {
    surface.every(530, () => {
      const s = surface.state
      if (s && (s.foco === 'editor' || s.dlg)) surface.setState({ ...s, parpadeo: !s.parpadeo })
    })
    surface.setState(inicial(m))
  }
  const S: Estado = surface.state ?? inicial(m)
  // Llegó lo leído del portapapeles (Ctrl+V): va al campo de la ventana o al editor.
  if (surface.state && m.pegado && m.pegado.n !== S.pegadoN) {
    const texto = m.pegado.texto
    if (S.dlg) {
      const d = S.dlg
      const limpio = texto.replace(/[\r\n\t]/g, '')
      surface.setState({ ...S, pegadoN: m.pegado.n, dlg: { ...d, campos: { ...d.campos, [d.campo]: (d.campos[d.campo] ?? '') + limpio }, claveTocada: d.claveTocada || d.campo === 'clave' } })
    } else if (S.foco === 'editor') {
      surface.setState({ ...S, pegadoN: m.pegado.n, parpadeo: true, pestanas: S.pestanas.map((p, i) => (i === S.pestana ? insertar(p, texto) : p)) })
    } else surface.setState({ ...S, pegadoN: m.pegado.n })
  }
  // Claude pidió una consulta: se abre en su pestaña y queda a la vista.
  if (surface.state && m.encargo && m.encargo.n !== S.encargoN) {
    const actual = surface.state
    const e = m.encargo.pestana
    let pestanas = actual.pestanas.some(p => p.id === e.id) ? actual.pestanas : [...actual.pestanas, { ...e, cur: aPos(e.sql, e.sql.length) }]
    const deClaude = pestanas.filter(p => p.id.startsWith('claude-'))
    if (deClaude.length > MAX_PESTANAS_CLAUDE) {
      const fuera = new Set(deClaude.slice(0, deClaude.length - MAX_PESTANAS_CLAUDE).map(p => p.id))
      pestanas = pestanas.filter(p => !fuera.has(p.id))
    }
    // Claude ocupa el editor: el foco sale de ahí para que lo que se teclee no caiga en su pestaña.
    surface.setState({ ...actual, encargoN: m.encargo.n, pestanas, pestana: pestanas.findIndex(p => p.id === e.id), foco: actual.foco === 'editor' ? null : actual.foco, menu: null, vista: 'res', conjunto: 0, fila: null, desdeFila: 0, desdeCol: 0, celda: null })
  }
  const W = surface.columns || 100
  const H = surface.rows || 30
  const T: Tema = m.tema === 'oscuro' ? OSCURO : CLARO
  const L = new Lienzo(W, H, T.chrome, S.hover)
  const cambiar = (fn: (s: Estado) => void) => {
    const nuevo = { ...S }
    fn(nuevo)
    surface.setState(nuevo)
  }
  const pedir = (p: Pedido) => surface.post(p)

  const tab = S.pestanas[S.pestana] ?? S.pestanas[0]!
  const conexion = m.conexiones.find(c => c.id === tab.conexion) ?? m.conexiones[0]
  const res = m.resultados[tab.id]
  const corriendo = res?.estado === 'corriendo'

  const ejecutar = () => {
    if (!conexion || corriendo) return
    if (!tab.sql.trim()) return
    pedir({ t: 'ejecutar', pestana: tab.id, conexion: conexion.id, base: tab.base || conexion.base, sql: tab.sql })
    cambiar(s => { s.vista = 'res'; s.conjunto = 0; s.fila = null; s.desdeFila = 0; s.desdeCol = 0 })
  }
  const nuevaPestana = (sql = '', con = conexion, base?: string, nombre?: string) => {
    cambiar(s => {
      s.n += 1
      s.pestanas = [...s.pestanas, { id: 'q' + s.n + '-' + Date.now(), nombre: nombre ?? `consulta${s.n}.sql`, conexion: con?.id ?? '', base: base ?? con?.base ?? '', sql, cur: { r: 0, c: 0 } }]
      s.pestana = s.pestanas.length - 1
      s.vista = 'res'
      s.foco = 'editor'
    })
  }
  const abrirDialogo = (c?: Conexion) => {
    cambiar(s => {
      s.menu = null
      s.dlg = {
        id: c?.id ?? null,
        motor: c?.motor ?? 'mssql',
        campos: {
          nombre: c?.nombre ?? '', host: c?.host ?? '', puerto: c?.puerto ?? '1433', usuario: c?.usuario ?? '',
          clave: '', base: c?.base ?? '', sshHost: c?.ssh?.host ?? '', sshLlave: c?.ssh?.llave ?? '',
        },
        campo: 'nombre',
        ssh: !!c?.ssh?.host,
        soloLectura: c?.soloLectura ?? false,
        color: Math.max(0, COLORES.indexOf(c?.color ?? COLORES[3]!)),
        claveTocada: false,
      }
    })
    pedir({ t: 'cerrarPrueba' })
  }

  // ── Barra de herramientas
  L.fill(0, 0, W, 2, T.chrome)
  let bx = 1
  bx = L.boton(bx, 0, corriendo ? '⠿ Ejecutando…' : '▶ Ejecutar  Ctrl+E', '#ffffff', T.ok, T.okHover, 'run', ejecutar) + 1
  bx = L.boton(bx, 0, '■ Detener', corriendo ? T.texto : T.tenue, T.pestanaOff, T.pestanaHover, 'stop', () => pedir({ t: 'cancelar', pestana: tab.id }), false) + 1
  bx = L.boton(bx, 0, '+ Nueva consulta', T.texto, T.pestanaOff, T.pestanaHover, 'new', () => nuevaPestana(), false) + 2
  if (conexion) {
    const h1 = L.zona(bx, 0, 18, 1, 'menuCon', () =>
      cambiar(s => {
        s.menu = { x: bx, y: 1, items: m.conexiones.map(c => ({ label: `● ${c.nombre}  (${nombreMotor(c.motor)})`, accion: () => cambiar(z => { z.menu = null; z.pestanas = z.pestanas.map((p, i) => (i === z.pestana ? { ...p, conexion: c.id, base: c.base } : p)) }) })) }
      }),
    )
    L.put(bx, 0, ' ● ', conexion.color, h1 ? T.hover : T.campo)
    bx = L.put(bx + 3, 0, recortar(conexion.nombre, 12) + '▾ ', T.texto, h1 ? T.hover : T.campo) + 1
    const bases = m.esquemas[conexion.id]?.bases ?? []
    const base = tab.base || conexion.base || '(predeterminada)'
    const anchoBase = limitar(base.length, 12, Math.max(12, W - 26 - bx - 3))
    const h2 = L.zona(bx, 0, anchoBase + 3, 1, 'menuBase', () => {
      if (!m.esquemas[conexion.id]?.bases) pedir({ t: 'esquema', conexion: conexion.id })
      cambiar(s => { s.menu = { x: bx, y: 1, items: bases.map(b => ({ label: b, accion: () => cambiar(z => { z.menu = null; z.pestanas = z.pestanas.map((p, i) => (i === z.pestana ? { ...p, base: b } : p)) }) })) } })
    })
    bx = L.put(bx, 0, ' ' + recortar(base, anchoBase) + '▾ ', T.texto, h2 ? T.hover : T.campo)
  }
  L.boton(W - 11, 0, m.tema === 'oscuro' ? '☀ Claro' : '◐ Oscuro', T.texto, T.pestanaOff, T.pestanaHover, 'tema', () => pedir({ t: 'tema', tema: m.tema === 'oscuro' ? 'claro' : 'oscuro' }), false)
  L.boton(W - 23, 0, m.ampliado ? '⤡ Reducir' : '⤢ Ampliar', T.texto, T.pestanaOff, T.pestanaHover, 'ampliar', () => pedir({ t: 'ampliar' }), false)

  // ── Sin conexiones: estado vacío
  if (m.conexiones.length === 0 && !S.dlg) {
    L.fill(0, 2, W, H - 2, T.panel)
    const cx = Math.floor(W / 2)
    ICONO_BASE.forEach((r, i) => L.put(cx - 3, 5 + i, r, T.acento, T.panel))
    L.put(cx - 9, 10, 'Aún no hay conexiones', T.texto, T.panel, true)
    const t2 = 'Registra un servidor SQL Server, PostgreSQL, MySQL o un archivo SQLite.'
    L.put(cx - Math.floor(t2.length / 2), 12, t2, T.tenue, T.panel)
    L.boton(cx - 9, 14, '+ Nueva conexión', '#ffffff', T.acento, T.primarioHover, 'vacioNueva', () => abrirDialogo())
    if (m.puente.error) L.put(2, H - 2, recortar('⚠ ' + m.puente.error, W - 4), T.error, T.panel)
    return pintar()
  }

  // ── Explorador de objetos: tan ancho como sus nombres (conexiones y bases),
  // o lo que se eligió arrastrando su borde.
  const EWmax = Math.max(18, W - 50)
  let anchoNombres = 26
  for (const c of m.conexiones) {
    anchoNombres = Math.max(anchoNombres, 7 + c.nombre.length + nombreMotor(c.motor).length + 3)
    if (S.abiertos[c.id]) for (const b of m.esquemas[c.id]?.bases ?? []) anchoNombres = Math.max(anchoNombres, 9 + b.length)
  }
  const EW = W < 80 ? 0 : S.anchoExp !== null ? limitar(S.anchoExp, 18, EWmax) : limitar(anchoNombres, Math.min(30, EWmax), Math.min(EWmax, Math.max(30, Math.floor(W * 0.35))))
  /** Nombres que el árbol tuvo que cortar, enteros, para mostrarlos al pasar el puntero. */
  const cortados: Record<string, string> = {}
  const EY = 2
  const EH = H - EY - 1
  if (EW > 0) {
    L.fill(0, EY, EW, EH, T.panel)
    L.put(0, EY, recortar(' Explorador de objetos', EW), T.texto, T.cabecera, true)
    const sc = S.sel ? m.conexiones.find(c => c.id === S.sel) : undefined
    if (sc) {
      const he = L.zona(EW - 6, EY, 1, 1, 'editar', () => abrirDialogo(sc))
      L.put(EW - 6, EY, '✎', he ? T.acento : T.tenue, T.cabecera)
    }
    const hp = L.zona(EW - 4, EY, 1, 1, 'mas', () => abrirDialogo())
    L.put(EW - 4, EY, '+', hp ? T.acento : T.tenue, T.cabecera, true)
    const hr = L.zona(EW - 2, EY, 1, 1, 'refrescar', () => sc && pedir({ t: 'esquema', conexion: sc.id }))
    L.put(EW - 2, EY, '⟳', hr ? T.acento : T.tenue, T.cabecera)
    let y = EY + 1
    const limite = EY + EH - 2
    const nodo = (nivel: number, clave: string, texto: string, extra: string, icono: string, colorIcono: string, hijos: (() => void) | null, alElegir?: () => void, negrita = false) => {
      if (y >= limite) return
      const x = 1 + nivel * 2
      const abierto = !!S.abiertos[clave]
      const h = L.zona(0, y, EW, 1, clave, () =>
        cambiar(s => {
          if (hijos) s.abiertos = { ...s.abiertos, [clave]: !abierto }
          s.sel = clave.split('/')[0]!
          s.menu = null
          alElegir?.()
        }),
      )
      if (S.sel === clave) L.fill(0, y, EW, 1, T.sel)
      else if (h) L.fill(0, y, EW, 1, T.hover)
      L.put(x, y, hijos ? (abierto ? '▾' : '▸') : ' ', T.tenue)
      L.put(x + 2, y, icono, colorIcono)
      const cabe = EW - x - 5
      if (texto.length > cabe || (extra && x + 4 + texto.length + 1 + extra.length > EW - 1)) cortados[clave] = extra ? `${texto} ${extra}` : texto
      const fin = L.put(x + 4, y, recortar(texto, cabe), T.texto, undefined, negrita)
      if (extra && fin + 1 < EW) L.put(fin + 1, y, recortar(extra, EW - fin - 2), T.tenue)
      y++
      if (hijos && abierto) hijos()
    }
    const aviso = (nivel: number, texto: string, color: string) => {
      if (y >= limite) return
      L.put(1 + nivel * 2, y, recortar(texto, EW - nivel * 2 - 2), color)
      y++
    }
    for (const c of m.conexiones) {
      const e = m.esquemas[c.id]
      nodo(0, c.id, c.nombre, `(${nombreMotor(c.motor)})`, '◆', c.color, () => {
        if (!e || (e.cargando ?? false)) return aviso(1, '⠿ Conectando…', T.tenue)
        if (e.error) return aviso(1, '✗ ' + e.error, T.error)
        for (const b of e.bases ?? []) {
          const objs = e.objetos[b]
          nodo(1, `${c.id}/b/${b}`, b, '', '▪', T.acento, () => {
            if (objs === undefined || objs === 'cargando') return aviso(2, '⠿ Cargando…', T.tenue)
            if (!Array.isArray(objs)) return aviso(2, '✗ ' + objs.error, T.error)
            for (const [tipo, etiqueta] of [['table', 'Tablas'], ['view', 'Vistas'], ['proc', 'Procedimientos']] as const) {
              const lista = objs.filter(o => o.kind === tipo)
              nodo(2, `${c.id}/b/${b}/${tipo}`, etiqueta, `${lista.length}`, '▪', T.tenue, () => {
                for (const o of lista) {
                  const nombre = o.schema ? `${o.schema}.${o.name}` : o.name
                  nodo(3, `${c.id}/b/${b}/${tipo}/${nombre}`, nombre, '', tipo === 'proc' ? 'ƒ' : '▦', T.texto, null)
                }
              }, undefined)
            }
          }, () => {
            if (objs === undefined) pedir({ t: 'esquema', conexion: c.id, base: b })
          })
        }
      }, () => {
        if (!e) pedir({ t: 'esquema', conexion: c.id })
      }, true)
    }
    const hn = L.zona(1, EY + EH - 2, 18, 1, 'nueva', () => abrirDialogo())
    L.put(2, EY + EH - 2, '+ Nueva conexión', T.acento, hn ? T.hover : T.panel, true)
    // El borde derecho se arrastra para cambiar el ancho.
    const hv = L.zona(EW, EY, 1, EH, 'divV', () => {})
    const colorBorde = hv || S.arrastre === 'v' ? T.acento : T.tenue
    for (let k = 0; k < EH; k++) L.put(EW, EY + k, k === Math.floor(EH / 2) ? '┃' : '│', colorBorde, T.chrome)
  }

  // ── Pestañas del editor
  const QX = EW + 1
  const QW = W - QX
  const etiquetaDe = (p: Pestana, i: number) => ` ${p.nombre}${i === S.pestana && res && corriendo ? ' ⠿' : ''} `
  const anchoPestana = (p: Pestana, i: number) => etiquetaDe(p, i).length + (S.pestanas.length > 1 ? 2 : 0) + 1
  let primera = 0
  while (primera < S.pestana && S.pestanas.slice(primera, S.pestana + 1).reduce((a, p, k) => a + anchoPestana(p, primera + k), 0) > QW - 2) primera++
  let tx = QX
  if (primera > 0) tx = L.put(QX, EY, '‹ ', T.tenue, T.chrome)
  S.pestanas.forEach((p, i) => {
    if (i < primera || tx + anchoPestana(p, i) - 1 > QX + QW) return
    const on = i === S.pestana
    const etiqueta = etiquetaDe(p, i)
    const h = L.zona(tx, EY, etiqueta.length, 1, 'tab' + i, () => cambiar(s => { s.pestana = i; s.vista = 'res'; s.conjunto = 0; s.fila = null; s.desdeFila = 0; s.desdeCol = 0 }))
    L.put(tx, EY, etiqueta, on ? T.texto : T.tenue, on ? T.pestana : h ? T.pestanaHover : T.pestanaOff, on)
    tx += etiqueta.length
    if (S.pestanas.length > 1) {
      const hx = L.zona(tx, EY, 2, 1, 'cerrar' + i, () =>
        cambiar(s => {
          s.pestanas = s.pestanas.filter((_, k) => k !== i)
          s.pestana = Math.min(s.pestana, s.pestanas.length - 1)
        }),
      )
      L.put(tx, EY, '✕ ', hx ? T.error : T.tenue, on ? T.pestana : T.pestanaOff)
      tx += 2
    }
    if (on) L.put(tx - etiqueta.length - (S.pestanas.length > 1 ? 2 : 0), EY - 1, '▄'.repeat(etiqueta.length + (S.pestanas.length > 1 ? 2 : 0)), T.acento, T.chrome)
    tx += 1
  })

  // ── Editor
  const ED = EY + 1
  const espacio = H - ED - 2
  const ELmax = Math.max(3, espacio - 3)
  const EL = limitar(S.altoEditor ?? Math.max(4, Math.floor(espacio * 0.42)), 3, ELmax)
  L.fill(QX, ED, QW, EL, T.fondo)
  const lineas = tab.sql.split('\n')
  const cur = tab.cur
  cur.r = Math.min(cur.r, lineas.length - 1)
  cur.c = Math.min(cur.c, lineas[cur.r]!.length)
  const arriba = Math.max(0, cur.r - EL + 2)
  const anchoNum = 4
  const desdeX = Math.max(0, cur.c - (QW - anchoNum - 4))
  L.zona(QX, ED, QW, EL, 'editor', () => {})
  let enComentario = false
  for (let i = 0; i < arriba; i++) enComentario = colorear(lineas[i]!, T, enComentario).sigue
  const sel = seleccion(tab)
  let offLinea = aOffset(lineas, { r: arriba, c: 0 })
  for (let k = 0; k < EL - 1; k++) {
    const i = arriba + k
    const y = ED + k
    if (i >= lineas.length) break
    if (S.foco === 'editor' && i === cur.r && !sel) L.fill(QX, y, QW, 1, T.lineaActual)
    L.put(QX, y, String(i + 1).padStart(anchoNum - 1), i === cur.r ? T.acento : T.margen)
    const { tokens, sigue } = colorear(lineas[i]!, T, enComentario)
    enComentario = sigue
    let x = QX + anchoNum + 1 - desdeX
    let off = offLinea
    for (const [s, c] of tokens) {
      for (const ch of s) {
        const marcada = sel !== null && off >= sel[0] && off < sel[1]
        if (x >= QX + anchoNum + 1 && x < QX + QW) L.put(x, y, ch, c, marcada ? T.sel : undefined)
        x++
        off++
      }
    }
    // el salto de línea seleccionado se ve como una celda marcada al final
    if (sel !== null && off >= sel[0] && off < sel[1] && x >= QX + anchoNum + 1 && x < QX + QW) L.put(x, y, ' ', T.texto, T.sel)
    offLinea += lineas[i]!.length + 1
  }
  if (!tab.sql && S.foco !== 'editor') L.put(QX + anchoNum + 1, ED, 'Haz clic aquí y escribe una consulta…', T.tenue)
  if (S.foco === 'editor' && S.parpadeo) {
    const x = QX + anchoNum + 1 + cur.c - desdeX
    const y = ED + cur.r - arriba
    const celda = L.celdas[y]?.[x]
    if (celda) { celda.b = T.texto; celda.f = T.fondo }
  }
  L.put(QX + QW - 22, ED + EL - 1, recortar(`Ln ${cur.r + 1}, Col ${cur.c + 1}`, 13), T.tenue, T.fondo)
  L.put(QX + QW - 8, ED + EL - 1, conexion ? (conexion.motor === 'mssql' ? 'T-SQL' : conexion.motor === 'postgres' ? 'PL/pgSQL' : 'SQL') : '', T.tenue, T.fondo)

  // ── Pestañas de resultados
  const RY = ED + EL
  L.fill(QX, RY, QW, 1, T.chrome)
  const hh = L.zona(QX, RY, QW, 1, 'divH', () => {})
  const pestanaRes = (x: number, etiqueta: string, vista: 'res' | 'msg') => {
    const on = S.vista === vista
    const h = L.zona(x, RY, etiqueta.length, 1, 'v' + vista, () => cambiar(s => { s.vista = vista }))
    L.put(x, RY, etiqueta, on ? T.texto : T.tenue, on ? T.pestana : h ? T.pestanaHover : T.pestanaOff, on)
    if (on) L.put(x, RY - 1, '▄'.repeat(etiqueta.length), T.acento, T.fondo)
    return x + etiqueta.length + 1
  }
  const conjuntos = res?.conjuntos ?? []
  const hayError = !!res?.fallo
  let rx = pestanaRes(QX, ' Resultados ', 'res')
  rx = pestanaRes(rx, hayError ? ' Mensajes ● ' : ' Mensajes ', 'msg')
  if (conjuntos.length > 1 && S.vista === 'res') {
    conjuntos.forEach((_, i) => {
      const on = S.conjunto === i
      const h = L.zona(rx, RY, 3, 1, 'cj' + i, () => cambiar(s => { s.conjunto = i; s.fila = null; s.desdeFila = 0; s.desdeCol = 0 }))
      L.put(rx, RY, ` ${i + 1} `, on ? '#ffffff' : T.texto, on ? T.acento : h ? T.pestanaHover : T.pestanaOff, on)
      rx += 4
    })
  }
  rx += 1
  L.put(rx, RY, '⇕', hh || S.arrastre === 'h' ? T.acento : T.tenue, T.chrome, true)
  rx = L.boton(rx + 2, RY, '▲', T.texto, T.pestanaOff, T.pestanaHover, 'masRes', () => cambiar(s => { s.altoEditor = limitar(EL - 3, 3, ELmax) }), false)
  L.boton(rx, RY, '▼', T.texto, T.pestanaOff, T.pestanaHover, 'masEd', () => cambiar(s => { s.altoEditor = limitar(EL + 3, 3, ELmax) }), false)
  if (res?.estado === 'listo' && conjuntos.length > 0) {
    let ax = QX + QW - 34
    ax = L.boton(ax, RY, 'Copiar', T.texto, T.pestanaOff, T.pestanaHover, 'copiar', () => pedir({ t: 'copiar', pestana: tab.id, formato: 'tsv' }), false) + 1
    ax = L.boton(ax, RY, 'CSV', T.texto, T.pestanaOff, T.pestanaHover, 'csv', () => pedir({ t: 'copiar', pestana: tab.id, formato: 'csv' }), false) + 1
    L.boton(ax, RY, 'Pasar a Claude', '#ffffff', T.claude, T.claudeHover, 'claude', () => pedir({ t: 'claude', pestana: tab.id, sql: tab.sql }))
  } else if (res?.estado === 'listo' && hayError) {
    L.boton(QX + QW - 18, RY, 'Pasar a Claude', '#ffffff', T.claude, T.claudeHover, 'claude', () => pedir({ t: 'claude', pestana: tab.id, sql: tab.sql }))
  }

  // ── Cuerpo: resultados o mensajes
  let columnaEn: (x: number) => number | null = () => null
  const GY = RY + 1
  const GH = H - GY - 1
  L.fill(QX, GY, QW, GH, T.fondo)
  L.zona(QX, GY, QW, GH, 'cuerpo', () => cambiar(s => { s.foco = 'resultados' }))
  if (corriendo) {
    L.put(QX + 2, GY + 1, '⠿ Ejecutando la consulta…', T.tenue)
  } else if (S.vista === 'msg') {
    const msgs = res?.mensajes ?? []
    if (msgs.length === 0) L.put(QX + 2, GY + 1, 'Sin mensajes todavía.', T.tenue)
    let y = GY + 1
    for (const msg of msgs) {
      for (const parte of envolver(msg.texto, QW - 4)) {
        if (y >= GY + GH) break
        L.put(QX + 2, y++, parte, msg.error ? T.error : T.texto, undefined, !!msg.error)
      }
    }
    if (res?.ms !== undefined && y + 1 < GY + GH) L.put(QX + 2, y + 1, `Duración: ${(res.ms / 1000).toFixed(3).replace('.', ',')} s`, T.tenue)
  } else {
    const cj = conjuntos[S.conjunto]
    if (!res) L.put(QX + 2, GY + 1, conexion ? 'Ejecuta la consulta (Ctrl+E, F5 o el botón ▶) para ver los resultados aquí.' : 'Elige o crea una conexión para empezar.', T.tenue)
    else if (!cj) L.put(QX + 2, GY + 1, hayError ? 'La consulta no devolvió resultados. Revisa la pestaña Mensajes.' : 'La consulta no devolvió filas. Revisa la pestaña Mensajes.', T.tenue)
    else {
      const anchos = cj.columnas.map((c, i) => Math.min(40, Math.max(c.length + 2, 6, ...cj.filas.slice(0, 200).map(f => (f[i] ?? 'NULL').length + 2))))
      const numW = String(cj.filas.length).length + 1
      L.fill(QX, GY, QW, 1, T.cabecera)
      let cx = QX + numW + 1
      for (let i = S.desdeCol; i < cj.columnas.length && cx < QX + QW; i++) {
        const w = anchos[i]!
        L.put(cx, GY, recortar(' ' + cj.columnas[i], Math.min(w, QX + QW - cx)), T.texto, T.cabecera, true)
        if (cx + w - 1 < QX + QW) L.put(cx + w - 1, GY, '│', T.tenue, T.cabecera)
        cx += w
      }
      const visibles = GH - 1
      // Dónde empieza cada columna visible, para saber qué celda toca un clic.
      const bordes: { c: number; x0: number; x1: number }[] = []
      for (let c = S.desdeCol, x = QX + numW + 1; c < cj.columnas.length && x < QX + QW; c++) {
        bordes.push({ c, x0: x, x1: x + anchos[c]! })
        x += anchos[c]!
      }
      columnaEn = (x: number) => bordes.find(b => x >= b.x0 && x < b.x1)?.c ?? null
      for (let k = 0; k < visibles; k++) {
        const i = S.desdeFila + k
        const f = cj.filas[i]
        if (!f) break
        const y = GY + 1 + k
        const fondo = S.fila === i ? T.sel : i % 2 ? T.cebra : T.fondo
        const h = L.zona(QX, y, QW, 1, 'fila' + i, () => cambiar(s => { s.fila = i; s.foco = 'resultados' }))
        L.fill(QX, y, QW, 1, h && S.fila !== i ? T.hover : fondo)
        L.put(QX, y, String(i + 1).padStart(numW) + ' ', T.tenue, T.cabecera)
        let x = QX + numW + 1
        for (let c = S.desdeCol; c < f.length && x < QX + QW; c++) {
          const w = Math.min(anchos[c]!, QX + QW - x)
          const v = f[c]
          const enCelda = S.celda?.f === i && S.celda.c === c
          if (enCelda) L.fill(x, y, w, 1, T.acento)
          if (v === null || v === undefined) L.put(x + 1, y, recortar('NULL', w - 2), enCelda ? '#ffffff' : T.tenue, enCelda ? T.acento : T.nulo)
          else L.put(x + 1, y, cj.numericas[c] ? v.slice(0, w - 2).padStart(w - 2) : recortar(v, w - 2), enCelda ? '#ffffff' : T.texto)
          x += anchos[c]!
        }
      }
      // desplazamiento
      const total = cj.filas.length
      if (total > visibles || S.desdeCol > 0 || cx >= QX + QW) {
        let sx = QX + QW - 15
        sx = L.boton(sx, GY, '◀', T.texto, T.pestanaOff, T.pestanaHover, 'izq', () => cambiar(s => { s.desdeCol = Math.max(0, s.desdeCol - 1) }), false)
        sx = L.boton(sx, GY, '▶', T.texto, T.pestanaOff, T.pestanaHover, 'der', () => cambiar(s => { s.desdeCol = Math.min(cj.columnas.length - 1, s.desdeCol + 1) }), false)
        sx = L.boton(sx, GY, '▲', T.texto, T.pestanaOff, T.pestanaHover, 'sub', () => cambiar(s => { s.desdeFila = Math.max(0, s.desdeFila - visibles) }), false)
        L.boton(sx, GY, '▼', T.texto, T.pestanaOff, T.pestanaHover, 'baj', () => cambiar(s => { s.desdeFila = Math.min(Math.max(0, total - visibles), s.desdeFila + visibles) }), false)
      }
    }
  }

  // ── Barra de estado
  const SY = H - 1
  const mal = hayError && !corriendo
  L.fill(0, SY, W, 1, mal ? T.estadoError : T.estado)
  const bajoPuntero = S.hover ? (cortados[S.hover] ?? AYUDAS[S.hover]) : undefined
  if (bajoPuntero && !S.arrastre) L.put(1, SY, recortar(bajoPuntero, W - 50), T.texto)
  else if (S.arrastre) L.put(1, SY, S.arrastre === 'v' ? `Explorador: ${EW} columnas` : `Consulta: ${EL - 1} líneas · resultados: ${H - ED - EL - 3} filas`, T.acento, undefined, true)
  else if (corriendo) L.put(1, SY, '⠿ Ejecutando…', T.tenue, undefined, true)
  else if (mal) L.put(1, SY, '✗ La consulta terminó con errores', T.error, undefined, true)
  else if (res?.estado === 'listo') L.put(1, SY, '✓ Consulta ejecutada correctamente', T.ok, undefined, true)
  else if (m.puente.error) L.put(1, SY, recortar('⚠ ' + m.puente.error, W - 50), T.error)
  else {
    // El error de la conexión elegida se lee entero aquí; en el árbol queda cortado.
    const errorConexion = S.sel ? m.esquemas[S.sel]?.error : undefined
    const aviso = m.aviso ?? (errorConexion ? `${m.conexiones.find(c => c.id === S.sel)?.nombre ?? ''}: ${errorConexion}` : null)
    L.put(1, SY, aviso ? recortar('⚠ ' + aviso, W - 50) : 'Listo', aviso ? T.error : T.tenue)
  }
  if (conexion) {
    const filas = res?.estado === 'listo' ? conjuntos.reduce((a, c) => a + c.total, 0) : 0
    const tiempo = res?.ms !== undefined && !corriendo ? (res.ms / 1000).toFixed(2).replace('.', ',') + ' s' : '--'
    const der = `${conexion.usuario || 'local'} · ${tab.base || conexion.base || '—'} · ${tiempo} · ${filas} ${filas === 1 ? 'fila' : 'filas'}${conexion.soloLectura ? ' · solo lectura' : ''}`
    const x = W - der.length - 1
    L.put(x - conexion.nombre.length - 3, SY, ` ${conexion.nombre} `, '#ffffff', conexion.color, true)
    L.put(x, SY, der, T.texto)
  }

  if (S.dlg) dibujarDialogo(S.dlg)
  if (S.menu) dibujarMenu(S.menu)
  return pintar()

  // ── Menú desplegable
  function dibujarMenu(menu: Menu) {
    const w = Math.min(W - 2, Math.max(18, ...menu.items.map(i => i.label.length + 2)))
    const x = limitar(menu.x, 0, W - w - 1)
    L.fill(x + 1, menu.y + 1, w, Math.max(1, menu.items.length), T.sombra)
    L.fill(x, menu.y, w, Math.max(1, menu.items.length), T.campo)
    if (menu.items.length === 0) L.put(x + 1, menu.y, 'Cargando…', T.tenue, T.campo)
    menu.items.forEach((it, i) => {
      const h = L.zona(x, menu.y + i, w, 1, 'mi' + i, it.accion)
      L.put(x, menu.y + i, recortar(' ' + it.label, w), T.texto, h ? T.sel : T.campo)
    })
  }

  // ── Ventana «Conectar al servidor»
  function camposDe(d: Dialogo): [string, string, string][] {
    const lite = d.motor === 'sqlite'
    const f: [string, string, string][] = [['nombre', 'Nombre', 'Ej.: Producción']]
    if (lite) f.push(['host', 'Archivo', '/ruta/a/base.db'])
    else
      f.push(
        ['host', 'Servidor', 'IP o nombre: 192.168.1.10, 100.x.x.x…'],
        ['puerto', 'Puerto', ''],
        ['usuario', 'Usuario', ''],
        ['clave', 'Contraseña', d.id ? '(sin cambios)' : ''],
        ['base', 'Base', '(opcional)'],
      )
    if (d.ssh && !lite) f.push(['sshHost', 'Equipo SSH', 'usuario@equipo-intermedio'], ['sshLlave', 'Llave SSH', '~/.ssh/id_ed25519 (o el agente)'])
    return f
  }
  function armar(d: Dialogo): Conexion {
    const c = d.campos
    return {
      id: d.id ?? 'c' + Date.now().toString(36),
      nombre: c.nombre!.trim() || c.host!.trim() || 'Conexión',
      motor: d.motor,
      host: c.host!.trim(),
      puerto: c.puerto!.trim(),
      usuario: c.usuario!.trim(),
      base: c.base!.trim(),
      color: COLORES[d.color]!,
      soloLectura: d.soloLectura,
      ssh: d.ssh && d.motor !== 'sqlite' && c.sshHost!.trim() ? { host: c.sshHost!.trim(), llave: c.sshLlave!.trim() } : null,
    }
  }
  function dibujarDialogo(d: Dialogo) {
    const campos = camposDe(d)
    const DW = Math.min(72, W - 4)
    const DH = 16 + campos.length * 2
    const x0 = Math.max(1, Math.floor((W - DW) / 2))
    const y0 = Math.max(1, Math.floor((H - DH) / 2))
    L.zona(0, 0, W, H, 'fondoDialogo', () => {})
    L.fill(x0 + 1, y0 + 1, DW, DH, T.sombra)
    L.fill(x0, y0, DW, DH, T.panel)
    L.fill(x0, y0, DW, 2, T.cabecera)
    L.put(x0 + 2, y0 + 1, d.id ? 'Editar conexión' : 'Conectar al servidor', T.texto, T.cabecera, true)
    const hx = L.zona(x0 + DW - 4, y0 + 1, 3, 1, 'cerrarDlg', () => cambiar(s => { s.dlg = null }))
    L.put(x0 + DW - 4, y0 + 1, ' ✕ ', hx ? '#ffffff' : T.tenue, hx ? T.error : T.cabecera)
    if (DW >= 60) ICONO_BASE.forEach((r, i) => L.put(x0 + DW - 10, y0 + 3 + i, r, COLORES[d.color], T.panel))
    let y = y0 + 3
    L.put(x0 + 2, y++, 'Motor', T.tenue)
    let ex = x0 + 2
    for (const [motor, nombre, puerto] of MOTORES) {
      const on = d.motor === motor
      const h = L.zona(ex, y, nombre.length + 2, 1, 'm' + motor, () =>
        cambiar(s => { s.dlg = { ...d, motor, campos: { ...d.campos, puerto }, campo: 'nombre', ssh: motor === 'sqlite' ? false : d.ssh } }),
      )
      L.put(ex, y, ` ${nombre} `, on ? '#ffffff' : T.texto, on ? T.acento : h ? T.pestanaHover : T.pestanaOff, on)
      ex += nombre.length + 3
    }
    y += 2
    const ancho = DW - 32
    for (const [k, etiqueta, ayuda] of campos) {
      const on = d.campo === k
      const h = L.zona(x0 + 16, y, ancho, 1, 'f' + k, () => cambiar(s => { s.dlg = { ...d, campo: k } }))
      L.put(x0 + 2, y, etiqueta, T.texto)
      const fondo = on ? T.campoOn : T.campo
      L.fill(x0 + 16, y, ancho, 1, fondo)
      let v = d.campos[k] ?? ''
      if (k === 'clave') v = '•'.repeat(v.length)
      const visible = v.length > ancho - 2 ? v.slice(v.length - (ancho - 2)) : v
      if (visible) L.put(x0 + 17, y, visible, T.texto, fondo)
      else if (ayuda && !on) L.put(x0 + 17, y, recortar(ayuda, ancho - 2), T.tenue, fondo)
      if (on) {
        L.put(x0 + 16, y + 1, '▀'.repeat(ancho), T.acento, T.panel)
        if (S.parpadeo) {
          const celda = L.celdas[y]?.[x0 + 17 + visible.length]
          if (celda) { celda.b = T.texto; celda.f = fondo }
        }
      } else if (h) L.put(x0 + 16, y + 1, '▀'.repeat(ancho), T.tenue, T.panel)
      y += 2
    }
    const casilla = (on: boolean, texto: string, id: string, accion: () => void, apagada = false) => {
      const h = !apagada && L.zona(x0 + 2, y, texto.length + 4, 1, id, accion)
      L.put(x0 + 2, y, on ? '▣' : '□', apagada ? T.tenue : on ? T.acento : T.tenue)
      L.put(x0 + 4, y, texto, apagada ? T.tenue : T.texto, h ? T.hover : undefined)
      y++
    }
    const lite = d.motor === 'sqlite'
    casilla(d.ssh && !lite, 'Conectar a través de un túnel SSH', 'ssh', () => cambiar(s => { s.dlg = { ...d, ssh: !d.ssh } }), lite)
    casilla(d.soloLectura, 'Solo lectura (bloquea INSERT, UPDATE, DELETE, DROP…)', 'ro', () => cambiar(s => { s.dlg = { ...d, soloLectura: !d.soloLectura } }))
    y++
    L.put(x0 + 2, y, 'Color', T.tenue)
    COLORES.forEach((c, i) => {
      const h = L.zona(x0 + 9 + i * 4, y, 3, 1, 'col' + i, () => cambiar(s => { s.dlg = { ...d, color: i } }))
      L.put(x0 + 9 + i * 4, y, d.color === i ? '[█]' : h ? ' █ ' : ' ▪ ', c)
    })
    if (DW >= 64) L.put(x0 + 35, y, 'se ve en la barra de estado', T.tenue)
    y += 2
    if (m.prueba) {
      const color = m.prueba.estado === 'ok' ? T.ok : m.prueba.estado === 'error' ? T.error : T.tenue
      for (const parte of envolver(m.prueba.texto, DW - 4).slice(0, 2)) L.put(x0 + 2, y++, parte, color, undefined, m.prueba.estado !== 'probando')
    }
    y = y0 + DH - 2
    if (d.id) {
      L.boton(x0 + 2, y, 'Borrar', T.error, T.pestanaOff, T.pestanaHover, 'borrar', () => {
        pedir({ t: 'borrar', conexion: d.id! })
        cambiar(s => { s.dlg = null; s.sel = null })
      }, false)
    }
    let bx2 = x0 + DW - 41
    bx2 = L.boton(bx2, y, 'Probar conexión', T.texto, T.pestanaOff, T.pestanaHover, 'probar', () => pedir({ t: 'probar', conexion: armar(d), clave: d.campos.clave ?? '' }), false) + 1
    bx2 = L.boton(bx2, y, 'Cancelar', T.texto, T.pestanaOff, T.pestanaHover, 'cancelar', () => cambiar(s => { s.dlg = null }), false) + 1
    L.boton(bx2, y, 'Guardar', '#ffffff', T.acento, T.primarioHover, 'guardar', () => guardarDialogo(d))
  }
  function guardarDialogo(d: Dialogo) {
    if (!d.campos.host!.trim()) {
      cambiar(s => { s.dlg = { ...d, campo: 'host' } })
      return
    }
    const c = armar(d)
    pedir({ t: 'guardar', conexion: c, clave: d.claveTocada || !d.id ? (d.campos.clave ?? '') : null })
    cambiar(s => {
      s.dlg = null
      s.sel = c.id
      s.abiertos = { ...s.abiertos, [c.id]: true }
      if (!s.pestanas.some(p => p.conexion)) s.pestanas = s.pestanas.map(p => ({ ...p, conexion: c.id, base: c.base }))
    })
  }

  // ── Pintar y escuchar
  function pintar() {
    const posEditor = (x: number, y: number): Pos => {
      const lin = tab.sql.split('\n')
      const r = Math.max(0, Math.min(lin.length - 1, arriba + y - ED))
      return { r, c: Math.max(0, Math.min(lin[r]!.length, x - QX - anchoNum - 1 + desdeX)) }
    }
    const conTab = (fn: (p: Pestana) => Pestana) => S.pestanas.map((p, i) => (i === S.pestana ? fn(p) : p))
    surface.onPointer((ev: ClientPointerEvent) => {
      const z = L.zonaEn(ev.x, ev.y)
      // Arrastrar un divisor: el explorador cambia de ancho o el editor de alto.
      if (S.arrastre && ev.type === 'move') {
        if (S.arrastre === 'v') {
          const ancho = limitar(ev.x, 18, EWmax)
          if (ancho !== EW) surface.setState({ ...S, anchoExp: ancho })
        } else {
          const alto = limitar(ev.y - ED, 3, ELmax)
          if (alto !== EL) surface.setState({ ...S, altoEditor: alto })
        }
        return
      }
      if (S.arrastre && (ev.type === 'up' || ev.type === 'leave')) {
        surface.setState({ ...S, arrastre: null })
        return
      }
      if (ev.type === 'down' && (!ev.button || ev.button === 'left') && (z?.id === 'divV' || z?.id === 'divH') && !S.dlg) {
        surface.setState({ ...S, menu: null, arrastre: z.id === 'divV' ? 'v' : 'h', ...(z.id === 'divV' ? { anchoExp: EW } : { altoEditor: EL }) })
        return
      }
      // Arrastrar con el botón apretado selecciona texto en el editor.
      if (S.arrastrando && ev.type === 'move') {
        const cur = posEditor(ev.x, ev.y)
        if (cur.r !== tab.cur.r || cur.c !== tab.cur.c) surface.setState({ ...S, pestanas: conTab(p => ({ ...p, cur })) })
        return
      }
      if (S.arrastrando && (ev.type === 'up' || ev.type === 'leave')) {
        const s = seleccion(tab)
        if (s) pedir({ t: 'copiarTexto', texto: tab.sql.slice(s[0], s[1]), que: 'Selección copiada.' })
        surface.setState({ ...S, arrastrando: false })
        return
      }
      if (ev.type === 'move' || ev.type === 'enter') {
        const id = z?.id ?? null
        if (id !== S.hover) surface.setState({ ...S, hover: id })
        return
      }
      if (ev.type === 'leave') {
        if (S.hover) surface.setState({ ...S, hover: null })
        return
      }
      if (ev.type !== 'down') return
      if (ev.button === 'right') return menuContextual(z?.id ?? '', ev.x, ev.y)
      if (ev.button && ev.button !== 'left') return
      if (S.menu && !(z && z.id.startsWith('mi')) && z?.id !== 'menuCon' && z?.id !== 'menuBase') {
        surface.setState({ ...S, menu: null })
        return
      }
      if (z?.id === 'editor') {
        const cur = posEditor(ev.x, ev.y)
        // Shift+clic extiende la selección; un clic solo la empieza de nuevo.
        surface.setState({ ...S, foco: 'editor', parpadeo: true, menu: null, arrastrando: true, celda: null, pestanas: conTab(p => ({ ...p, cur, ancla: ev.shift ? p.ancla ?? p.cur : cur })) })
        return
      }
      if (z?.id.startsWith('fila')) {
        const f = Number(z.id.slice(4))
        const c = columnaEn(ev.x)
        surface.setState({ ...S, fila: f, celda: c === null ? null : { f, c }, foco: 'resultados', menu: null })
        return
      }
      if (z && abrirSiTabla(z.id)) return
      if (z) {
        if (z.id !== 'cuerpo' && !z.id.startsWith('fila') && !z.id.startsWith('f') && S.foco === 'editor' && !S.dlg) S.foco = null
        z.accion()
      } else if (S.foco) surface.setState({ ...S, foco: null })
    })
    surface.onKey((ev: ClientKeyEvent) => teclas(ev))
    const filas = L.tramos()
    return (
      <Box flexDirection="column" width={W} height={H}>
        {filas.map(fila => (
          <Text wrap="truncate-end">
            {fila.map(t => (
              <Text color={t.f} backgroundColor={t.b} bold={t.bold}>
                {t.s}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  }

  // Clic derecho: copiar y pegar donde se hizo.
  function menuContextual(id: string, x: number, y: number) {
    const abrirMenu = (items: Menu['items'], extra: Partial<Estado> = {}) => {
      const w = Math.max(18, ...items.map(i => i.label.length + 2))
      surface.setState({ ...S, ...extra, menu: { x: Math.min(x, W - w - 1), y: Math.min(y, H - items.length - 1), items } })
    }
    const cerrar = (fn: () => void) => () => { fn(); surface.setState({ ...(surface.state ?? S), menu: null }) }
    if (id === 'editor') {
      const s = seleccion(tab)
      const items: Menu['items'] = []
      if (s) {
        items.push({ label: 'Copiar selección', accion: cerrar(() => pedir({ t: 'copiarTexto', texto: tab.sql.slice(s[0], s[1]), que: 'Selección copiada.' })) })
        items.push({ label: 'Cortar selección', accion: () => { pedir({ t: 'copiarTexto', texto: tab.sql.slice(s[0], s[1]), que: 'Selección cortada.' }); surface.setState({ ...S, menu: null, pestanas: S.pestanas.map((p, i) => (i === S.pestana ? insertar(p, '') : p)) }) } })
      }
      items.push({ label: 'Copiar toda la consulta', accion: cerrar(() => pedir({ t: 'copiarTexto', texto: tab.sql, que: 'Consulta copiada.' })) })
      items.push({ label: 'Pegar            Ctrl+V', accion: () => { surface.setState({ ...S, menu: null, foco: 'editor' }); pedir({ t: 'pegar' }) } })
      items.push({ label: 'Seleccionar todo Ctrl+A', accion: () => surface.setState({ ...S, menu: null, foco: 'editor', pestanas: S.pestanas.map((p, i) => (i === S.pestana ? { ...p, ancla: { r: 0, c: 0 }, cur: aPos(p.sql, p.sql.length) } : p)) }) })
      return abrirMenu(items, { foco: 'editor' })
    }
    if (id.startsWith('fila')) {
      const f = Number(id.slice(4))
      const c = columnaEn(x)
      const cj = res?.conjuntos[S.conjunto]
      const parte = (fila: number | null, columna: number | null) => cerrar(() => pedir({ t: 'copiarParte', pestana: tab.id, conjunto: S.conjunto, fila, columna }))
      const items: Menu['items'] = []
      if (c !== null) items.push({ label: 'Copiar celda', accion: parte(f, c) })
      items.push({ label: 'Copiar fila (con encabezados)', accion: parte(f, null) })
      if (c !== null && cj) items.push({ label: `Copiar columna «${recortar(cj.columnas[c] ?? '', 18).trim()}»`, accion: parte(null, c) })
      items.push({ label: 'Copiar todo (con encabezados)', accion: parte(null, null) })
      return abrirMenu(items, { fila: f, celda: c === null ? null : { f, c }, foco: 'resultados' })
    }
    if (id.startsWith('f') && S.dlg) {
      return abrirMenu([{ label: 'Pegar  Ctrl+V', accion: () => { surface.setState({ ...S, menu: null, dlg: { ...S.dlg!, campo: id.slice(1) } }); pedir({ t: 'pegar' }) } }])
    }
  }

  // Un clic en una tabla o vista del árbol abre sus primeras filas.
  function abrirSiTabla(id: string): boolean {
    const partes = id.split('/')
    if (partes.length !== 5 || partes[1] !== 'b' || (partes[3] !== 'table' && partes[3] !== 'view')) return false
    const [idCon, , base, , nombre] = partes as [string, string, string, string, string]
    const c = m.conexiones.find(x => x.id === idCon)
    const lista = m.esquemas[idCon]?.objetos[base!]
    if (!c || !Array.isArray(lista)) return false
    const o = lista.find(x => (x.schema ? `${x.schema}.${x.name}` : x.name) === nombre)
    if (!o) return false
    const sql = consultaDeTabla(c.motor, o)
    const n = S.n + 1
    const p: Pestana = { id: 'q' + n + '-' + Date.now(), nombre: `${o.name}.sql`, conexion: c.id, base, sql, cur: { r: 0, c: 0 } }
    surface.setState({ ...S, n, sel: id, pestanas: [...S.pestanas, p], pestana: S.pestanas.length, vista: 'res', conjunto: 0, fila: null, desdeFila: 0, desdeCol: 0, foco: null })
    pedir({ t: 'ejecutar', pestana: p.id, conexion: c.id, base, sql })
    return true
  }

  function teclas(ev: ClientKeyEvent) {
    const leida = leerTecla(ev)
    if (!leida) return
    const k = 'tecla' in leida ? leida.tecla : ''
    // Ctrl+E como en SSMS; Ctrl+Enter donde la terminal lo distingue; F5 si llega.
    if (k === 'f5' || (ev.ctrl && (k === 'return' || ('texto' in leida && leida.texto.toLowerCase() === 'e')))) return ejecutar()
    if (S.dlg) return teclasDialogo(S.dlg, ev, leida)
    if (S.foco === 'resultados') {
      const cj = conjuntos[S.conjunto]
      if (!cj) return
      const paso = Math.max(1, H - (ED + EL) - 3)
      const max = Math.max(0, cj.filas.length - 1)
      const f = S.fila ?? S.desdeFila
      let nf = f
      if (k === 'down') nf = Math.min(max, f + 1)
      else if (k === 'up') nf = Math.max(0, f - 1)
      else if (k === 'pagedown') nf = Math.min(max, f + paso)
      else if (k === 'pageup') nf = Math.max(0, f - paso)
      else if (k === 'right') return cambiar(s => { s.desdeCol = Math.min(cj.columnas.length - 1, s.desdeCol + 1) })
      else if (k === 'left') return cambiar(s => { s.desdeCol = Math.max(0, s.desdeCol - 1) })
      else return
      const desde = nf < S.desdeFila ? nf : nf >= S.desdeFila + paso ? nf - paso + 1 : S.desdeFila
      return cambiar(s => { s.fila = nf; s.desdeFila = desde })
    }
    if (S.foco !== 'editor') return
    const poner = (p: Pestana) => surface.setState({ ...S, parpadeo: true, pestanas: S.pestanas.map((x, i) => (i === S.pestana ? p : x)) })
    const letra = 'texto' in leida ? leida.texto.toLowerCase() : ''
    // Atajos con Ctrl (Ctrl+C no llega: la terminal lo usa para soltar el panel).
    if (ev.ctrl) {
      const s = seleccion(tab)
      if (letra === 'a') return poner({ ...tab, ancla: { r: 0, c: 0 }, cur: aPos(tab.sql, tab.sql.length) })
      if (letra === 'v') return pedir({ t: 'pegar' })
      if (letra === 'x' && s) {
        pedir({ t: 'copiarTexto', texto: tab.sql.slice(s[0], s[1]), que: 'Selección cortada.' })
        return poner(insertar(tab, ''))
      }
      if (letra === 'k') {
        pedir({ t: 'copiarTexto', texto: s ? tab.sql.slice(s[0], s[1]) : tab.sql, que: s ? 'Selección copiada.' : 'Consulta copiada.' })
        return
      }
      if (k === '') return
    }
    const lin = tab.sql.split('\n')
    const c = { ...tab.cur }
    const l = lin[c.r]!
    const mover = k === 'left' || k === 'right' || k === 'up' || k === 'down' || k === 'home' || k === 'end' || k === 'pageup' || k === 'pagedown'
    if (mover) {
      const s = seleccion(tab)
      // Sin Shift, ← y → sobre una selección van a su borde, como en cualquier editor.
      if (!ev.shift && s && (k === 'left' || k === 'right')) return poner({ ...tab, cur: aPos(tab.sql, k === 'left' ? s[0] : s[1]), ancla: null })
      if (k === 'left') { if (c.c > 0) c.c--; else if (c.r > 0) { c.r--; c.c = lin[c.r]!.length } }
      else if (k === 'right') { if (c.c < l.length) c.c++; else if (c.r < lin.length - 1) { c.r++; c.c = 0 } }
      else if (k === 'up') { if (c.r > 0) { c.r--; c.c = Math.min(c.c, lin[c.r]!.length) } }
      else if (k === 'down') { if (c.r < lin.length - 1) { c.r++; c.c = Math.min(c.c, lin[c.r]!.length) } }
      else if (k === 'home') c.c = 0
      else if (k === 'end') c.c = l.length
      else if (k === 'pageup') { c.r = Math.max(0, c.r - (EL - 2)); c.c = Math.min(c.c, lin[c.r]!.length) }
      else if (k === 'pagedown') { c.r = Math.min(lin.length - 1, c.r + (EL - 2)); c.c = Math.min(c.c, lin[c.r]!.length) }
      return poner({ ...tab, cur: c, ancla: ev.shift ? tab.ancla ?? tab.cur : null })
    }
    if (k === 'backspace' || k === 'delete') {
      if (seleccion(tab)) return poner(insertar(tab, ''))
      const off = aOffset(lin, c)
      const [a, b] = k === 'backspace' ? [Math.max(0, off - 1), off] : [off, Math.min(tab.sql.length, off + 1)]
      if (a === b) return
      const sql = tab.sql.slice(0, a) + tab.sql.slice(b)
      return poner({ ...tab, sql, cur: aPos(sql, a), ancla: null })
    }
    if (k === 'return') return poner(insertar(tab, '\n' + l.slice(0, c.c).match(/^\s*/)![0]))
    if (k === 'tab') return poner(insertar(tab, '    '))
    // Un carácter o un trozo pegado con el pegado de la terminal.
    if (!ev.meta && 'texto' in leida) return poner(insertar(tab, leida.texto))
  }

  function teclasDialogo(d: Dialogo, ev: ClientKeyEvent, leida: { tecla: string } | { texto: string }) {
    const lista = camposDe(d).map(f => f[0])
    const k = 'tecla' in leida ? leida.tecla : ''
    const actual = d.campos[d.campo] ?? ''
    if (k === 'tab' || k === 'down' || k === 'up') {
      const i = lista.indexOf(d.campo)
      const paso = ev.shift || k === 'up' ? lista.length - 1 : 1
      return cambiar(s => { s.dlg = { ...d, campo: lista[(i + paso) % lista.length]! } })
    }
    if (k === 'return') return guardarDialogo(d)
    if (k === 'backspace') return cambiar(s => { s.dlg = { ...d, campos: { ...d.campos, [d.campo]: actual.slice(0, -1) }, claveTocada: d.claveTocada || d.campo === 'clave' } })
    if (ev.ctrl && 'texto' in leida && leida.texto.toLowerCase() === 'v') return pedir({ t: 'pegar' })
    if (ev.ctrl || ev.meta) return
    if ('texto' in leida) {
      const texto = leida.texto.replace(/[\n\t]/g, '')
      return cambiar(s => { s.dlg = { ...d, campos: { ...d.campos, [d.campo]: actual + texto }, claveTocada: d.claveTocada || d.campo === 'clave' } })
    }
  }
}

function envolver(texto: string, ancho: number): string[] {
  // Con el panel angosto el ancho llega a 0 o menos: sin este piso el corte no avanza nunca.
  ancho = Math.max(1, ancho)
  const out: string[] = []
  for (const linea of texto.split('\n')) {
    let resto = linea
    while (resto.length > ancho) {
      let corte = resto.lastIndexOf(' ', ancho)
      if (corte <= 0) corte = ancho
      out.push(resto.slice(0, corte))
      resto = resto.slice(corte).trimStart()
    }
    out.push(resto)
  }
  return out
}

export default Estudio
