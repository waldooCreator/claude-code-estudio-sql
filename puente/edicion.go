package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
)

// ── Edición en la cuadrícula
//
// Una celda se puede editar cuando la consulta lee de una sola tabla y trae su
// clave completa: así el UPDATE toca exactamente una fila. SQL Server y
// PostgreSQL dicen de qué tabla y columna sale cada dato; en MySQL y SQLite se
// reconoce la forma sencilla SELECT … FROM tabla.

type tableRef struct {
	Database string `json:"database,omitempty"`
	Schema   string `json:"schema,omitempty"`
	Name     string `json:"name"`
}

type editableIn struct {
	Conn     Conn     `json:"conn"`
	Database string   `json:"database"`
	SQL      string   `json:"sql"`
	Columns  []string `json:"columns"` // las del resultado, en orden
}

type editableOut struct {
	Editable bool     `json:"editable"`
	Reason   string   `json:"reason,omitempty"`
	Table    tableRef `json:"table"`
	Display  string   `json:"display"`
	// Por columna del resultado: la columna de la tabla de la que sale, o "" si
	// no se puede editar (calculada, de otra tabla, identidad…).
	Sources []string `json:"sources"`
	// Posiciones en el resultado de las columnas de la clave, y sus nombres en la tabla.
	Key        []int    `json:"key"`
	KeyColumns []string `json:"keyColumns"`
	todas      []string // por columna del resultado, la de la tabla aunque no se pueda escribir
}

func noEditable(reason string) (any, error) {
	return editableOut{Editable: false, Reason: reason, Sources: []string{}, Key: []int{}, KeyColumns: []string{}}, nil
}

func handleEditable(in editableIn) (any, error) {
	if in.Conn.ReadOnly {
		return noEditable("La conexión es de solo lectura. Para editar, desactiva «Solo lectura» en la conexión (clic derecho → Editar).")
	}
	sqlText := strings.TrimSpace(in.SQL)
	clean := strings.TrimSpace(commentsAndStrings.ReplaceAllStringFunc(sqlText, func(m string) string {
		if strings.HasPrefix(m, "--") || strings.HasPrefix(m, "/*") {
			return " "
		}
		return "''"
	}))
	if !singleStatement(clean) || !regexp.MustCompile(`(?i)^\s*(SELECT|WITH)\b`).MatchString(clean) {
		return noEditable("Solo se editan los resultados de una consulta SELECT de una sola sentencia.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := open(ctx, in.Conn, in.Database)
	if err != nil {
		return nil, err
	}
	var out editableOut
	switch in.Conn.Engine {
	case "mssql":
		out, err = editableMSSQL(ctx, db, strings.TrimRight(sqlText, "; \n\t"), in.Columns)
	case "postgres":
		out, err = editablePostgres(ctx, db, strings.TrimRight(sqlText, "; \n\t"), in.Columns)
	default:
		out, err = editableSimple(ctx, db, in.Conn.Engine, clean, in.Columns)
	}
	if err != nil {
		return nil, friendly(err)
	}
	if out.Sources == nil {
		out.Sources = []string{}
	}
	if out.Key == nil {
		out.Key = []int{}
	}
	out.KeyColumns = []string{}
	for _, i := range out.Key {
		out.KeyColumns = append(out.KeyColumns, out.todas[i])
	}
	return out, nil
}

// La tabla única de la que salen las columnas, o el motivo por el que no hay una.
func unaTabla(tablas map[tableRef]bool) (tableRef, string) {
	if len(tablas) == 0 {
		return tableRef{}, "Ninguna columna sale directamente de una tabla."
	}
	if len(tablas) > 1 {
		return tableRef{}, "La consulta combina varias tablas: para editar, consulta una sola."
	}
	for t := range tablas {
		return t, ""
	}
	return tableRef{}, ""
}

// Las posiciones de la clave en el resultado; falla si falta alguna columna.
func claveEnResultado(sources []string, clave []string) ([]int, string) {
	if len(clave) == 0 {
		return nil, "La tabla no tiene clave primaria: no hay cómo saber qué fila cambiar."
	}
	pos := []int{}
	faltan := []string{}
	for _, k := range clave {
		i := -1
		for j, s := range sources {
			if strings.EqualFold(s, k) {
				i = j
				break
			}
		}
		if i < 0 {
			faltan = append(faltan, k)
			continue
		}
		pos = append(pos, i)
	}
	if len(faltan) > 0 {
		return nil, "Para editar, incluye en la consulta la clave de la tabla: " + strings.Join(faltan, ", ") + "."
	}
	return pos, ""
}

func editableMSSQL(ctx context.Context, db *sql.DB, q string, cols []string) (editableOut, error) {
	rows, err := db.QueryContext(ctx, "EXEC sys.sp_describe_first_result_set @tsql = @p1, @params = NULL, @browse_information_mode = 1", q)
	if err != nil {
		return editableOut{}, err
	}
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return editableOut{}, err
	}
	type desc struct {
		hidden, key, updatable          bool
		name, db, schema, table, column string
	}
	var visibles []desc
	var claves []desc
	for rows.Next() {
		vals := make([]any, len(names))
		ptrs := make([]any, len(names))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return editableOut{}, err
		}
		m := map[string]any{}
		for i, n := range names {
			m[n] = vals[i]
		}
		d := desc{
			hidden:    asBool(m["is_hidden"]),
			key:       asBool(m["is_part_of_unique_key"]),
			updatable: asBool(m["is_updateable"]),
			name:      asString(m["name"]),
			db:        asString(m["source_database"]),
			schema:    asString(m["source_schema"]),
			table:     asString(m["source_table"]),
			column:    asString(m["source_column"]),
		}
		if d.key {
			claves = append(claves, d)
		}
		if !d.hidden {
			visibles = append(visibles, d)
		}
	}
	if err := rows.Err(); err != nil {
		return editableOut{}, err
	}
	if len(visibles) != len(cols) {
		return editableOut{Reason: "La consulta devolvió otras columnas que las descritas por el servidor: vuelve a ejecutarla."}, nil
	}
	tablas := map[tableRef]bool{}
	sources := make([]string, len(visibles))
	for i, d := range visibles {
		if d.table == "" || d.column == "" {
			continue
		}
		tablas[tableRef{Database: d.db, Schema: d.schema, Name: d.table}] = true
		if d.updatable {
			sources[i] = d.column
		}
	}
	t, motivo := unaTabla(tablas)
	if motivo != "" {
		return editableOut{Reason: motivo}, nil
	}
	clave := []string{}
	for _, d := range claves {
		if d.table == t.Name && d.schema == t.Schema {
			clave = append(clave, d.column)
		}
	}
	// La clave se busca entre todas las columnas que salen de la tabla, aunque no se puedan editar (una identidad).
	todas := make([]string, len(visibles))
	for i, d := range visibles {
		if d.table == t.Name && d.schema == t.Schema {
			todas[i] = d.column
		}
	}
	key, motivo := claveEnResultado(todas, clave)
	if motivo != "" {
		return editableOut{Reason: motivo}, nil
	}
	return editableOut{Editable: true, Table: t, Display: quoteTable("mssql", t), Sources: sources, Key: key, todas: todas}, nil
}

func editablePostgres(ctx context.Context, db *sql.DB, q string, cols []string) (editableOut, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return editableOut{}, err
	}
	defer conn.Close()
	type campo struct {
		oid  uint32
		attn uint16
	}
	var campos []campo
	err = conn.Raw(func(dc any) error {
		c, ok := dc.(*stdlib.Conn)
		if !ok {
			return errors.New("conexión de PostgreSQL inesperada")
		}
		sd, err := c.Conn().Prepare(ctx, "", q)
		if err != nil {
			return err
		}
		for _, f := range sd.Fields {
			campos = append(campos, campo{f.TableOID, f.TableAttributeNumber})
		}
		return nil
	})
	if err != nil {
		return editableOut{}, err
	}
	if len(campos) != len(cols) {
		return editableOut{Reason: "La consulta devolvió otras columnas que las descritas por el servidor: vuelve a ejecutarla."}, nil
	}
	oids := map[uint32]bool{}
	for _, c := range campos {
		if c.oid != 0 && c.attn > 0 {
			oids[c.oid] = true
		}
	}
	if len(oids) == 0 {
		return editableOut{Reason: "Ninguna columna sale directamente de una tabla."}, nil
	}
	if len(oids) > 1 {
		return editableOut{Reason: "La consulta combina varias tablas: para editar, consulta una sola."}, nil
	}
	var oid uint32
	for o := range oids {
		oid = o
	}
	var t tableRef
	var kind string
	if err := conn.QueryRowContext(ctx, `SELECT n.nspname, c.relname, c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1`, oid).Scan(&t.Schema, &t.Name, &kind); err != nil {
		return editableOut{}, err
	}
	if kind != "r" && kind != "p" {
		return editableOut{Reason: "Los datos salen de una vista, no de una tabla: consulta la tabla para editar."}, nil
	}
	nombres := map[uint16]string{}
	editables := map[uint16]bool{}
	rows, err := conn.QueryContext(ctx, `SELECT attnum, attname, attgenerated = '' AND attidentity <> 'a' FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`, oid)
	if err != nil {
		return editableOut{}, err
	}
	for rows.Next() {
		var n int
		var name string
		var ok bool
		if err := rows.Scan(&n, &name, &ok); err != nil {
			rows.Close()
			return editableOut{}, err
		}
		nombres[uint16(n)] = name
		editables[uint16(n)] = ok
	}
	rows.Close()
	clave := []string{}
	krows, err := conn.QueryContext(ctx, `SELECT a.attname FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY u(attnum, i) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum WHERE k.conrelid = $1 AND k.contype = 'p' ORDER BY u.i`, oid)
	if err != nil {
		return editableOut{}, err
	}
	for krows.Next() {
		var s string
		if err := krows.Scan(&s); err != nil {
			krows.Close()
			return editableOut{}, err
		}
		clave = append(clave, s)
	}
	krows.Close()
	sources := make([]string, len(campos))
	todas := make([]string, len(campos))
	for i, c := range campos {
		if c.oid == oid && c.attn > 0 {
			todas[i] = nombres[c.attn]
			if editables[c.attn] {
				sources[i] = nombres[c.attn]
			}
		}
	}
	key, motivo := claveEnResultado(todas, clave)
	if motivo != "" {
		return editableOut{Reason: motivo}, nil
	}
	return editableOut{Editable: true, Table: t, Display: quoteTable("postgres", t), Sources: sources, Key: key, todas: todas}, nil
}

// SELECT columnas FROM tabla [alias] [WHERE …] [ORDER BY …] [LIMIT …], ya sin comentarios ni textos.
var selectSimple = regexp.MustCompile(`(?is)^\s*SELECT\s+(.+?)\s+FROM\s+((?:[A-Za-z_][\w$]*|"[^"]+"|` + "`[^`]+`" + `)(?:\.(?:[A-Za-z_][\w$]*|"[^"]+"|` + "`[^`]+`" + `))?)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?\s*(?:(?:WHERE|ORDER\s+BY|LIMIT)\b.*)?;?\s*$`)
var complejo = regexp.MustCompile(`(?i)\b(JOIN|UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|DISTINCT)\b`)
var identificador = regexp.MustCompile(`^(?:([A-Za-z_]\w*)\.)?([A-Za-z_][\w$]*|"[^"]+"|` + "`[^`]+`" + `)$`)

func sinComillas(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '`') {
		return s[1 : len(s)-1]
	}
	return s
}

func editableSimple(ctx context.Context, db *sql.DB, engine, clean string, cols []string) (editableOut, error) {
	m := selectSimple.FindStringSubmatch(clean)
	if m == nil || complejo.MatchString(clean) {
		return editableOut{Reason: "Para editar en " + nombreMotor(engine) + ", la consulta debe ser SELECT … FROM una sola tabla (sin JOIN, GROUP BY ni UNION)."}, nil
	}
	lista, tabla, alias := strings.TrimSpace(m[1]), m[2], m[3]
	if strings.EqualFold(alias, "WHERE") || strings.EqualFold(alias, "ORDER") || strings.EqualFold(alias, "LIMIT") {
		alias = ""
	}
	var t tableRef
	if parts := strings.SplitN(tabla, ".", 2); len(parts) == 2 && !strings.HasPrefix(tabla, `"`) && !strings.HasPrefix(tabla, "`") {
		t = tableRef{Schema: sinComillas(parts[0]), Name: sinComillas(parts[1])}
	} else {
		t = tableRef{Name: sinComillas(tabla)}
	}
	// Las columnas de la tabla, cuáles se pueden escribir y la clave primaria.
	columnas := map[string]bool{}
	clave := []string{}
	switch engine {
	case "mysql":
		rows, err := db.QueryContext(ctx, `SELECT COLUMN_NAME, COLUMN_KEY = 'PRI', EXTRA NOT LIKE '%GENERATED%' FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(NULLIF(?, ''), DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, t.Schema, t.Name)
		if err != nil {
			return editableOut{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var n string
			var pk, ok bool
			if err := rows.Scan(&n, &pk, &ok); err != nil {
				return editableOut{}, err
			}
			columnas[strings.ToLower(n)] = ok
			if pk {
				clave = append(clave, n)
			}
		}
		if err := rows.Err(); err != nil {
			return editableOut{}, err
		}
	case "sqlite":
		var tipo string
		if err := db.QueryRowContext(ctx, `SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE`, t.Name).Scan(&tipo); err != nil || tipo != "table" {
			return editableOut{Reason: "Los datos no salen de una tabla: consulta la tabla para editar."}, nil
		}
		rows, err := db.QueryContext(ctx, `SELECT name, pk FROM pragma_table_info(?) ORDER BY pk`, t.Name)
		if err != nil {
			return editableOut{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var n string
			var pk int
			if err := rows.Scan(&n, &pk); err != nil {
				return editableOut{}, err
			}
			columnas[strings.ToLower(n)] = true
			if pk > 0 {
				clave = append(clave, n)
			}
		}
		if err := rows.Err(); err != nil {
			return editableOut{}, err
		}
	default:
		return editableOut{Reason: "Este motor no permite editar en la cuadrícula."}, nil
	}
	if len(columnas) == 0 {
		return editableOut{Reason: "No encontré la tabla " + tabla + "."}, nil
	}
	// Las columnas pedidas por su nombre, sin expresiones ni alias.
	todo := lista == "*" || (alias != "" && lista == alias+".*")
	pedidas := map[string]bool{}
	if !todo {
		for _, p := range strings.Split(lista, ",") {
			p = strings.TrimSpace(p)
			if id := identificador.FindStringSubmatch(p); id != nil && (id[1] == "" || strings.EqualFold(id[1], alias) || strings.EqualFold(id[1], t.Name)) {
				pedidas[strings.ToLower(sinComillas(id[2]))] = true
			}
		}
	}
	sources := make([]string, len(cols))
	todas := make([]string, len(cols))
	for i, c := range cols {
		lc := strings.ToLower(c)
		if ok, existe := columnas[lc]; existe && (todo || pedidas[lc]) {
			todas[i] = c
			if ok {
				sources[i] = c
			}
		}
	}
	key, motivo := claveEnResultado(todas, clave)
	if motivo != "" {
		return editableOut{Reason: motivo}, nil
	}
	return editableOut{Editable: true, Table: t, Display: quoteTable(engine, t), Sources: sources, Key: key, todas: todas}, nil
}

func nombreMotor(engine string) string {
	return map[string]string{"mssql": "SQL Server", "postgres": "PostgreSQL", "mysql": "MySQL", "sqlite": "SQLite"}[engine]
}

func asBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	}
	return false
}

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}

// ── El UPDATE

type keyVal struct {
	Column string `json:"column"`
	Value  any    `json:"value"`
}

type updateIn struct {
	Conn     Conn     `json:"conn"`
	Database string   `json:"database"`
	Table    tableRef `json:"table"`
	Column   string   `json:"column"`
	Key      []keyVal `json:"key"`
	Value    *string  `json:"value"`    // nil: NULL
	Original any      `json:"original"` // lo que se veía al empezar a editar
	DryRun   bool     `json:"dryRun"`   // solo devuelve el UPDATE, sin ejecutarlo
}

func quoteIdent(engine, s string) string {
	switch engine {
	case "mssql":
		return "[" + strings.ReplaceAll(s, "]", "]]") + "]"
	case "mysql":
		return "`" + strings.ReplaceAll(s, "`", "``") + "`"
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

func quoteTable(engine string, t tableRef) string {
	parts := []string{}
	if t.Database != "" && engine == "mssql" {
		parts = append(parts, quoteIdent(engine, t.Database))
	}
	if t.Schema != "" {
		parts = append(parts, quoteIdent(engine, t.Schema))
	} else if t.Database != "" && engine == "mssql" {
		parts = append(parts, "")
	}
	return strings.Join(append(parts, quoteIdent(engine, t.Name)), ".")
}

func placeholder(engine string, n int) string {
	switch engine {
	case "mssql":
		return "@p" + strconv.Itoa(n)
	case "postgres":
		return "$" + strconv.Itoa(n)
	}
	return "?"
}

// literal es el valor como se leería escrito en el UPDATE que ve la persona.
func literal(engine string, v any) string {
	switch x := v.(type) {
	case nil:
		return "NULL"
	case float64, int64, int:
		return fmt.Sprint(param(x))
	case string:
		q := "'" + strings.ReplaceAll(x, "'", "''") + "'"
		if engine == "mssql" {
			return "N" + q
		}
		return q
	}
	return fmt.Sprint(v)
}

// param deja los números enteros que llegan de JSON como enteros.
func param(v any) any {
	if f, ok := v.(float64); ok && f == float64(int64(f)) {
		return int64(f)
	}
	return v
}

// mismo compara dos valores tal como los muestra la cuadrícula.
func mismo(a, b any) bool {
	norm := func(v any) string {
		switch x := param(v).(type) {
		case nil:
			return "\x00NULL"
		case float64:
			return strconv.FormatFloat(x, 'f', -1, 64)
		}
		return fmt.Sprint(param(v))
	}
	return norm(a) == norm(b)
}

type sentencia struct {
	sql, vista string
	args       []any
}

func armarUpdate(engine string, in updateIn, tipos map[string]string) (upd, sel sentencia) {
	tabla := quoteTable(engine, in.Table)
	col := quoteIdent(engine, in.Column)
	// En PostgreSQL un parámetro de texto no se convierte solo a número o fecha: se castea al tipo de la columna.
	ph := func(n int, columna string) string {
		p := placeholder(engine, n)
		if t := tipos[columna]; engine == "postgres" && t != "" {
			return p + "::text::" + t
		}
		return p
	}
	var valor any
	if in.Value != nil {
		valor = *in.Value
	}
	argsWhere := []any{}
	condV, condS := []string{}, []string{}
	for i, k := range in.Key {
		v := param(k.Value)
		if engine == "postgres" && v != nil {
			v = fmt.Sprint(v)
		}
		argsWhere = append(argsWhere, v)
		condS = append(condS, quoteIdent(engine, k.Column)+" = "+ph(i+1, k.Column))
		condV = append(condV, quoteIdent(engine, k.Column)+" = "+literal(engine, k.Value))
	}
	sel = sentencia{
		sql:  "SELECT " + col + " FROM " + tabla + " WHERE " + strings.Join(condS, " AND "),
		args: argsWhere,
	}
	condU := []string{}
	for i, k := range in.Key {
		condU = append(condU, quoteIdent(engine, k.Column)+" = "+ph(i+2, k.Column))
	}
	upd = sentencia{
		sql:   "UPDATE " + tabla + " SET " + col + " = " + ph(1, in.Column) + " WHERE " + strings.Join(condU, " AND "),
		vista: "UPDATE " + tabla + " SET " + col + " = " + literal(engine, valor) + " WHERE " + strings.Join(condV, " AND "),
		args:  append([]any{valor}, argsWhere...),
	}
	return upd, sel
}

func handleUpdate(in updateIn) (any, error) {
	if in.Table.Name == "" || in.Column == "" || len(in.Key) == 0 {
		return nil, errors.New("Falta la tabla, la columna o la clave de la fila.")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	engine := in.Conn.Engine
	tipos := map[string]string{}
	if engine == "postgres" && !in.DryRun {
		db, err := open(ctx, in.Conn, in.Database)
		if err != nil {
			return nil, err
		}
		rows, err := db.QueryContext(ctx, `SELECT attname, format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, quoteTable(engine, in.Table))
		if err != nil {
			return nil, friendly(err)
		}
		for rows.Next() {
			var n, t string
			if err := rows.Scan(&n, &t); err == nil {
				tipos[n] = t
			}
		}
		rows.Close()
	}
	upd, sel := armarUpdate(engine, in, tipos)
	if in.DryRun {
		return map[string]any{"sql": upd.vista}, nil
	}
	if in.Conn.ReadOnly {
		return nil, errors.New("La conexión es de solo lectura: no se guardó nada.")
	}
	db, err := open(ctx, in.Conn, in.Database)
	if err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, friendly(err)
	}
	defer func() { _ = tx.Rollback() }()

	leer := func() (any, int, error) {
		rows, err := tx.QueryContext(ctx, sel.sql, sel.args...)
		if err != nil {
			return nil, 0, err
		}
		defer rows.Close()
		tipo := ""
		if ts, err := rows.ColumnTypes(); err == nil && len(ts) == 1 {
			tipo = strings.ToLower(ts[0].DatabaseTypeName())
		}
		var v any
		n := 0
		for rows.Next() {
			n++
			if err := rows.Scan(&v); err != nil {
				return nil, n, err
			}
		}
		return cell(v, tipo), n, rows.Err()
	}

	actual, n, err := leer()
	if err != nil {
		return nil, friendly(err)
	}
	switch {
	case n == 0:
		return nil, errors.New("La fila ya no existe: alguien la borró o le cambió la clave. Vuelve a ejecutar la consulta.")
	case n > 1:
		return nil, fmt.Errorf("La clave no identifica una sola fila (hay %d): no se guardó nada.", n)
	case !mismo(actual, in.Original):
		return nil, fmt.Errorf("Alguien cambió este valor mientras lo editabas: ahora es %s. No se guardó nada; vuelve a ejecutar la consulta.", literal(engine, actual))
	}
	res, err := tx.ExecContext(ctx, upd.sql, upd.args...)
	if err != nil {
		return nil, friendly(err)
	}
	if k, err := res.RowsAffected(); err == nil && k != 1 {
		return nil, fmt.Errorf("El UPDATE habría cambiado %d filas en vez de una: se deshizo.", k)
	}
	nuevo, _, err := leer()
	if err != nil {
		return nil, friendly(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, friendly(err)
	}
	return map[string]any{"ok": true, "sql": upd.vista, "value": nuevo}, nil
}
