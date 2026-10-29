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
}

export type Resultado = {
  estado: 'corriendo' | 'listo'
  conexion: string
  base: string
  ms?: number
  fallo?: boolean
  error?: string
  conjuntos: { columnas: string[]; numericas: boolean[]; filas: (string | null)[][]; total: number; recortado: boolean }[]
  mensajes: { texto: string; error?: boolean }[]
}

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

declare module 'claude-code' {
  interface PluginState {
    'estudio-sql': { modelo: Modelo }
  }
}
