export type Motor = 'mssql' | 'postgres' | 'mysql' | 'sqlite'

/** Una conexión guardada. La contraseña nunca está aquí: vive en el llavero. */
export type Conexion = {
  id: string
  nombre: string
  motor: Motor
  host: string
  puerto: string
  usuario: string
  base: string
  color: string
  soloLectura: boolean
  ssh: { host: string; llave: string } | null
}

export type Objeto = { schema: string; name: string; kind: 'table' | 'view' | 'proc' }

export type Esquema = {
  cargando?: boolean
  error?: string
  bases?: string[]
  objetos: Record<string, Objeto[] | 'cargando' | { error: string }>
  /** Bases con más objetos de los que viajan al panel: cuántos hay de cada tipo. */
  totales?: Record<string, Record<Objeto['kind'], number>>
}

export type Resultado = {
  estado: 'corriendo' | 'listo'
  conexion: string
  base: string
  ms?: number
  fallo?: boolean
  error?: string
  conjuntos: Conjunto[]
  mensajes: { texto: string; error?: boolean }[]
}

/**
 * Un conjunto de resultados. Al panel solo viaja la ventana que está a la vista:
 * las filas desde `desde` y, de cada una, las columnas desde `col0`. El resto
 * se queda en el mod (para copiar y para Claude) y llega al desplazarse.
 */
export type Conjunto = {
  columnas: string[]
  numericas: boolean[]
  /** Ancho de cada columna en celdas, medido sobre todas las filas. */
  anchos: number[]
  filas: (string | null)[][]
  desde: number
  col0: number
  total: number
  recortado: boolean
}

/**
 * Lo que el panel le cuenta al mod (y el mod le devuelve en las props como acuse):
 * qué mira (de esa pestaña y ese conjunto viajan las filas), qué pestañas siguen
 * abiertas (las demás se borran) y el último pegado que ya insertó.
 */
export type Vista = { pestana: string; conjunto: number; desde: number; col: number; pestanas: string[]; pegado: number }

export type Prueba = { estado: 'probando' | 'ok' | 'error'; texto: string }

/** Lo que el mod le entrega al panel en cada dibujo. */
export type Modelo = {
  conexiones: Conexion[]
  esquemas: Record<string, Esquema>
  resultados: Record<string, Resultado>
  prueba: Prueba | null
  puente: { listo: boolean; error?: string }
  tema: 'claro' | 'oscuro'
  aviso: string | null
  ampliado: boolean
  /** Lo último leído del portapapeles del sistema; `n` cambia en cada lectura. */
  pegado: { n: number; texto: string } | null
  /** La última consulta que pidió Claude: el panel la abre en una pestaña; `n` cambia con cada una. */
  encargo: { n: number; pestana: Encargo } | null
  /** La ventana de filas que trae este dibujo (solo en las props del panel). */
  vista?: Vista
}

/** Una consulta que Claude ejecuta a la vista: la pestaña que el panel abre para ella. */
export type Encargo = { id: string; nombre: string; conexion: string; base: string; sql: string }

/** Lo que el panel le pide al mod. */
export type Pedido =
  | { t: 'esquema'; conexion: string; base?: string }
  | { t: 'ejecutar'; pestana: string; conexion: string; base: string; sql: string }
  | { t: 'cancelar'; pestana: string }
  | { t: 'probar'; conexion: Conexion; clave: string }
  | { t: 'guardar'; conexion: Conexion; clave: string | null }
  | { t: 'borrar'; conexion: string }
  | { t: 'tema'; tema: 'claro' | 'oscuro' }
  | { t: 'copiar'; pestana: string; formato: 'tsv' | 'csv' }
  | { t: 'claude'; pestana: string; sql: string }
  | { t: 'cerrarPrueba' }
  | { t: 'copiarTexto'; texto: string; que: string }
  | { t: 'copiarParte'; pestana: string; conjunto: number; fila: number | null; columna: number | null }
  | { t: 'pegar' }
  | { t: 'ampliar' }
  /** Solo la vista; cualquier otro pedido también la lleva (el motor entrega un pedido por cuadro). */
  | { t: 'ver' }

declare module 'claude-code' {
  interface PluginState {
    'estudio-sql': { modelo: Modelo; vista: Vista; fallas: { n: number; motivo: string } }
  }
}
