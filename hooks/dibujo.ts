// La cuadrícula de celdas que dibuja Estudio SQL, sus dos temas y el
// coloreado de SQL. Todo se pinta celda a celda y al final se agrupa en
// tramos del mismo color para entregarlo a la terminal.

export type Tema = typeof CLARO

export const CLARO = {
  chrome: '#eeeef2', panel: '#f5f5f7', fondo: '#ffffff', texto: '#1e1e1e', tenue: '#6d6d78',
  sel: '#cce8ff', hover: '#e5f1fb', acento: '#0078d4', cabecera: '#e6e7eb', cebra: '#f7f8fa', margen: '#2b91af',
  kw: '#0000ff', fn: '#c800c8', str: '#a31515', num: '#098658', com: '#008000', op: '#7a7a7a',
  ok: '#107c10', error: '#c42b1c', estado: '#fdf3d0', estadoError: '#fde7e9', pestana: '#ffffff', pestanaOff: '#e3e4e8',
  pestanaHover: '#d6d7dc', lineaActual: '#f3f7fc', sombra: '#c9cad0', campo: '#ffffff', campoOn: '#ffffff', nulo: '#fffbe0',
  claude: '#d97757', claudeHover: '#c4643f', primarioHover: '#005a9e', okHover: '#0e6a0e',
}

export const OSCURO: Tema = {
  chrome: '#2d2d30', panel: '#252526', fondo: '#1e1e1e', texto: '#dcdcdc', tenue: '#9a9aa5',
  sel: '#264f78', hover: '#2a2d2e', acento: '#3794ff', cabecera: '#333337', cebra: '#232324', margen: '#2b91af',
  kw: '#569cd6', fn: '#d670d6', str: '#d69d85', num: '#b5cea8', com: '#57a64a', op: '#b4b4b4',
  ok: '#6ccb5f', error: '#f1707b', estado: '#3a3520', estadoError: '#4b1f24', pestana: '#1e1e1e', pestanaOff: '#3a3a3e',
  pestanaHover: '#46464b', lineaActual: '#262a30', sombra: '#151517', campo: '#333337', campoOn: '#3c3c41', nulo: '#3b3a23',
  claude: '#d97757', claudeHover: '#c4643f', primarioHover: '#1c6fc9', okHover: '#4fae43',
}

export type Celda = { c: string; f: string; b: string; bold: boolean }
export type Zona = { x: number; y: number; w: number; h: number; id: string; accion: () => void }

/** Una cuadrícula de cols × filas con las zonas que responden al clic. */
export class Lienzo {
  celdas: Celda[][]
  zonas: Zona[] = []
  constructor(readonly cols: number, readonly filas: number, fondo: string, private hoverId: string | null) {
    this.celdas = Array.from({ length: filas }, () => Array.from({ length: cols }, () => ({ c: ' ', f: '#000000', b: fondo, bold: false })))
  }
  put(x: number, y: number, s: string, f?: string, b?: string, bold = false): number {
    for (const ch of s) {
      const fila = this.celdas[y]
      if (fila && x >= 0 && x < this.cols) {
        const c = fila[x]!
        // Un tabulador o un \r (pegados, o dentro de una celda) correrían la cuadrícula,
        // y un carácter de control C1 (U+0080–U+009F, texto mal convertido) tumba el panel.
        c.c = ch < ' ' || (ch >= '\x7f' && ch <= '\x9f') ? ' ' : ch
        if (f) c.f = f
        if (b) c.b = b
        c.bold = bold
      }
      x++
    }
    return x
  }
  fill(x: number, y: number, w: number, h: number, b: string, f = '#000000'): void {
    for (let j = y; j < y + h; j++) {
      const fila = this.celdas[j]
      if (!fila) continue
      for (let i = x; i < x + w; i++) if (i >= 0 && i < this.cols) fila[i] = { c: ' ', f, b, bold: false }
    }
  }
  /** Registra una zona clicable y dice si el puntero está encima. */
  zona(x: number, y: number, w: number, h: number, id: string, accion: () => void): boolean {
    this.zonas.push({ x, y, w, h, id, accion })
    return this.hoverId === id
  }
  boton(x: number, y: number, label: string, f: string, b: string, bh: string, id: string, accion: () => void, bold = true): number {
    const h = this.zona(x, y, label.length + 2, 1, id, accion)
    this.put(x, y, ` ${label} `, f, h ? bh : b, bold)
    return x + label.length + 2
  }
  /** La zona más alta bajo una celda (la última registrada gana). */
  zonaEn(x: number, y: number): Zona | undefined {
    for (let i = this.zonas.length - 1; i >= 0; i--) {
      const z = this.zonas[i]!
      if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return z
    }
    return undefined
  }
  /**
   * Cada fila como tramos de un mismo estilo, listos para Text. El motor no
   * acepta un dibujo de más de 100 000 caracteres, y cada tramo pesa: un espacio
   * no muestra su color de letra, así que se suma al tramo vecino del mismo fondo.
   * `nivel` 1 junta también letras de distinto color; 2 deja un tramo por fila.
   */
  tramos(nivel: 0 | 1 | 2 = 0): Tramo[][] {
    return this.celdas.map(fila => {
      if (nivel === 2) return [{ s: fila.map(c => c.c).join(''), f: fila.find(c => c.c !== ' ')?.f ?? fila[0]!.f, b: fila[0]!.b, bold: false }]
      const out: (Tramo & { blanco: boolean })[] = []
      for (const c of fila) {
        const last = out[out.length - 1]
        if (last && last.b === c.b) {
          if (c.c === ' ' || nivel === 1 || (last.f === c.f && last.bold === c.bold)) {
            last.s += c.c
            if (c.c !== ' ') last.blanco = false
            continue
          }
          // El tramo anterior es solo espacios: toma el estilo de esta letra.
          if (last.blanco) {
            last.s += c.c
            last.f = c.f
            last.bold = c.bold
            last.blanco = false
            continue
          }
        }
        out.push({ s: c.c, f: c.f, b: c.b, bold: c.bold, blanco: c.c === ' ' })
      }
      return out
    })
  }
}

export type Tramo = { s: string; f: string; b: string; bold: boolean }

/** Lo que pesa un dibujo para el motor (de más) y cuántos elementos tiene. */
export function pesoDibujo(filas: Tramo[][]): { caracteres: number; nodos: number } {
  let caracteres = 0
  let nodos = 0
  for (const fila of filas) {
    caracteres += 60
    nodos += 1 + fila.length
    for (const t of fila) caracteres += JSON.stringify(t.s).length + 90
  }
  return { caracteres, nodos }
}

export const recortar = (s: string, n: number): string =>
  n <= 0 ? '' : s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s + ' '.repeat(n - s.length)

// ── Coloreado de SQL, con las palabras de los cuatro motores

const PALABRAS = new Set(
  ('SELECT TOP FROM WHERE JOIN LEFT RIGHT FULL INNER OUTER CROSS APPLY ON AS GROUP BY ORDER DESC ASC AND OR NOT NULL IS IN ' +
    'EXISTS BETWEEN LIKE ILIKE INSERT INTO VALUES UPDATE SET DELETE MERGE CREATE TABLE VIEW INDEX PROCEDURE FUNCTION ALTER DROP ' +
    'TRUNCATE HAVING DISTINCT CASE WHEN THEN ELSE END LIMIT OFFSET FETCH NEXT ROWS ONLY WITH UNION ALL EXCEPT INTERSECT DECLARE ' +
    'BEGIN COMMIT ROLLBACK TRANSACTION TRAN USE GO EXEC EXECUTE RETURN IF WHILE PRINT RETURNING PRIMARY KEY FOREIGN REFERENCES ' +
    'DEFAULT CONSTRAINT NOLOCK OVER PARTITION SHOW DESCRIBE EXPLAIN PRAGMA').split(' '),
)
const FUNCIONES = new Set(
  ('SUM COUNT MAX MIN AVG CAST CONVERT GETDATE SYSDATETIME NOW CURRENT_TIMESTAMP COALESCE ISNULL IFNULL NULLIF ROUND FLOOR ' +
    'CEILING ABS LEN LENGTH UPPER LOWER TRIM LTRIM RTRIM SUBSTRING SUBSTR REPLACE CONCAT DATEADD DATEDIFF DATEPART YEAR MONTH ' +
    'DAY FORMAT ROW_NUMBER RANK DENSE_RANK LAG LEAD STRING_AGG GROUP_CONCAT DATE_TRUNC EXTRACT IIF CHARINDEX').split(' '),
)

export type Token = [texto: string, color: string]

// Expresiones «pegajosas» (y): buscan justo en lastIndex, sin copiar el resto de
// la línea en cada paso (con líneas larguísimas eso era cuadrático).
const CADENA = /N?'(?:[^']|'')*'?/y
const CITA = /\[[^\]]*\]?|"[^"]*"?|`[^`]*`?/y
const NUMERO = /\d+(\.\d+)?/y
const NOMBRE = /[@#]{0,2}[A-Za-z_][\w$]*/y
const OPERADOR = /[(),;*=<>!+\-/%.]+/y

function en(re: RegExp, s: string, i: number): string | null {
  re.lastIndex = i
  return re.exec(s)?.[0] ?? null
}

/**
 * Parte una línea en tramos coloreados. `enComentario` sigue un /* abierto;
 * con `soloEstado` no arma los tramos (las líneas que no se ven solo dicen eso).
 */
export function colorear(linea: string, t: Tema, enComentario = false, soloEstado = false): { tokens: Token[]; sigue: boolean } {
  const out: Token[] = []
  const poner = (s: string, c: string) => { if (!soloEstado) out.push([s, c]) }
  let i = 0
  let comentario = enComentario
  let m: string | null
  while (i < linea.length) {
    if (comentario) {
      const fin = linea.indexOf('*/', i)
      const s = fin < 0 ? linea.slice(i) : linea.slice(i, fin + 2)
      poner(s, t.com)
      i += s.length
      comentario = fin < 0
      continue
    }
    if (linea.startsWith('--', i)) { poner(linea.slice(i), t.com); break }
    if (linea.startsWith('/*', i)) { comentario = true; continue }
    if ((m = en(CADENA, linea, i))) { poner(m, t.str); i += m.length; continue }
    if ((m = en(CITA, linea, i))) { poner(m, t.texto); i += m.length; continue }
    if ((m = en(NUMERO, linea, i))) { poner(m, t.num); i += m.length; continue }
    if ((m = en(NOMBRE, linea, i))) {
      if (!soloEstado) {
        const u = m.toUpperCase()
        poner(m, PALABRAS.has(u) ? t.kw : FUNCIONES.has(u) ? t.fn : t.texto)
      }
      i += m.length
      continue
    }
    if ((m = en(OPERADOR, linea, i))) { poner(m, t.op); i += m.length; continue }
    poner(linea[i]!, t.texto)
    i++
  }
  return { tokens: out, sigue: comentario }
}
