package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ── Probar conexión

type testIn struct {
	Conn Conn `json:"conn"`
}

func handleTest(in testIn) (any, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db, err := open(ctx, in.Conn, "")
	if err != nil {
		return nil, err
	}
	var ver string
	q := map[string]string{
		"mssql":    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64))",
		"postgres": "SHOW server_version",
		"mysql":    "SELECT VERSION()",
		"sqlite":   "SELECT sqlite_version()",
	}[in.Conn.Engine]
	_ = db.QueryRowContext(ctx, q).Scan(&ver)
	// La prueba no deja la conexión abierta: puede tener una contraseña sin guardar.
	if in.Conn.Password != "" {
		closeConn(in.Conn.ID)
	}
	return map[string]any{"ok": true, "version": ver, "ms": time.Since(start).Milliseconds()}, nil
}

// ── Ejecutar

type queryIn struct {
	QueryID  string `json:"queryId"`
	Conn     Conn   `json:"conn"`
	Database string `json:"database"`
	SQL      string `json:"sql"`
	MaxRows  int    `json:"maxRows"`
}

type resultSet struct {
	Columns   []string `json:"columns"`
	Types     []string `json:"types"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated"`
}

type message struct {
	Text  string `json:"text"`
	Error bool   `json:"error,omitempty"`
}

type queryOut struct {
	Results  []resultSet `json:"results"`
	Messages []message   `json:"messages"`
	Ms       int64       `json:"ms"`
	Failed   bool        `json:"failed"`
}

var (
	runningMu sync.Mutex
	running   = map[string]context.CancelFunc{}
)

func handleQuery(in queryIn) (any, error) {
	if strings.TrimSpace(in.SQL) == "" {
		return nil, errors.New("No hay nada que ejecutar.")
	}
	if in.MaxRows <= 0 {
		in.MaxRows = 1000
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if in.QueryID != "" {
		runningMu.Lock()
		running[in.QueryID] = cancel
		runningMu.Unlock()
		defer func() { runningMu.Lock(); delete(running, in.QueryID); runningMu.Unlock() }()
	}

	start := time.Now()
	out := queryOut{Results: []resultSet{}, Messages: []message{}}
	db, err := open(ctx, in.Conn, in.Database)
	if err != nil {
		return nil, err
	}

	// SQL Server y MySQL devuelven varios resultados por lote; SQLite y
	// PostgreSQL solo el último, así que ahí se ejecuta sentencia por sentencia.
	batches := []string{in.SQL}
	switch in.Conn.Engine {
	case "mssql":
		batches = splitGO(in.SQL)
	case "sqlite", "postgres":
		batches = splitStatements(in.SQL)
	}
	if in.Conn.ReadOnly {
		for _, b := range batches {
			if w := firstWriteStatement(b); w != "" {
				return nil, fmt.Errorf("Esta conexión es de solo lectura y la consulta tiene «%s». Quita esa sentencia o desactiva «Solo lectura» en la conexión.", w)
			}
		}
	}

	// Una sola conexión física para todos los lotes: así un USE o una tabla
	// temporal del primero sigue valiendo en el siguiente.
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, friendly(err)
	}
	defer conn.Close()

	for _, batch := range batches {
		if strings.TrimSpace(batch) == "" {
			continue
		}
		if err := runBatch(ctx, conn, batch, in.MaxRows, &out); err != nil {
			out.Failed = true
			text := err.Error()
			if errors.Is(ctx.Err(), context.Canceled) {
				text = "Consulta cancelada."
			}
			out.Messages = append(out.Messages, message{Text: text, Error: true})
			break
		}
	}
	out.Ms = time.Since(start).Milliseconds()
	return out, nil
}

var ddl = regexp.MustCompile(`(?i)^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b`)

var returnsRows =regexp.MustCompile(`(?i)^\s*(SELECT|WITH|PRAGMA|SHOW|EXPLAIN|VALUES|TABLE|DESCRIBE|DESC|EXEC|EXECUTE|CALL)\b|\bRETURNING\b`)

func runBatch(ctx context.Context, conn *sql.Conn, batch string, maxRows int, out *queryOut) error {
	clean := strings.TrimSpace(commentsAndStrings.ReplaceAllStringFunc(batch, func(m string) string {
		if strings.HasPrefix(m, "--") || strings.HasPrefix(m, "/*") {
			return " "
		}
		return "''"
	}))
	if clean == "" || clean == ";" {
		return nil
	}
	// Una sola sentencia que no devuelve filas: Exec, para poder contar las afectadas.
	if !returnsRows.MatchString(clean) && singleStatement(clean) {
		res, err := conn.ExecContext(ctx, batch)
		if err != nil {
			return err
		}
		// En SQLite un CREATE o DROP repite el conteo de la sentencia anterior: no se cuenta.
		if n, err := res.RowsAffected(); err == nil && n > 0 && !ddl.MatchString(clean) {
			out.Messages = append(out.Messages, message{Text: fmt.Sprintf("(%d %s)", n, plural(int(n), "fila afectada", "filas afectadas"))})
		} else {
			out.Messages = append(out.Messages, message{Text: "Comando completado correctamente."})
		}
		return nil
	}
	before := len(out.Results)
	rows, err := conn.QueryContext(ctx, batch)
	if err != nil {
		return err
	}
	defer rows.Close()
	for {
		cols, err := rows.Columns()
		if err != nil {
			return err
		}
		if len(cols) > 0 {
			rs := resultSet{Columns: cols, Rows: [][]any{}}
			if types, err := rows.ColumnTypes(); err == nil {
				for _, t := range types {
					rs.Types = append(rs.Types, strings.ToLower(t.DatabaseTypeName()))
				}
			}
			n := 0
			for rows.Next() {
				if n >= maxRows {
					rs.Truncated = true
					n++
					continue // se cuentan para el mensaje, sin guardarlas
				}
				vals := make([]any, len(cols))
				ptrs := make([]any, len(cols))
				for i := range vals {
					ptrs[i] = &vals[i]
				}
				if err := rows.Scan(ptrs...); err != nil {
					return err
				}
				for i, v := range vals {
					vals[i] = cell(v, rs.typeAt(i))
				}
				rs.Rows = append(rs.Rows, vals)
				n++
			}
			out.Results = append(out.Results, rs)
			msg := fmt.Sprintf("(%d %s)", n, plural(n, "fila", "filas"))
			if rs.Truncated {
				msg += fmt.Sprintf(" · se muestran las primeras %d", maxRows)
			}
			out.Messages = append(out.Messages, message{Text: msg})
		}
		if !rows.NextResultSet() {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(out.Results) == before {
		out.Messages = append(out.Messages, message{Text: "Comandos completados correctamente."})
	}
	return nil
}

// singleStatement dice si el texto ya limpio es una sola sentencia.
func singleStatement(clean string) bool {
	return !strings.Contains(strings.TrimRight(clean, "; \n\t"), ";")
}

// splitStatements parte un script por «;» sin cortar dentro de textos,
// comentarios, identificadores entre comillas ni bloques $$ de PostgreSQL.
func splitStatements(s string) []string {
	var out []string
	start, i := 0, 0
	for i < len(s) {
		switch {
		case strings.HasPrefix(s[i:], "--"):
			if j := strings.IndexByte(s[i:], '\n'); j >= 0 {
				i += j
			} else {
				i = len(s)
			}
		case strings.HasPrefix(s[i:], "/*"):
			if j := strings.Index(s[i+2:], "*/"); j >= 0 {
				i += j + 4
			} else {
				i = len(s)
			}
		case s[i] == '\'' || s[i] == '"':
			q := s[i]
			i++
			for i < len(s) {
				if s[i] == q {
					if i+1 < len(s) && s[i+1] == q {
						i += 2
						continue
					}
					break
				}
				i++
			}
			i++
		case s[i] == '$':
			if m := dollarTag.FindString(s[i:]); m != "" {
				if j := strings.Index(s[i+len(m):], m); j >= 0 {
					i += len(m) + j + len(m)
					continue
				}
			}
			i++
		case s[i] == ';':
			out = append(out, s[start:i+1])
			i++
			start = i
		default:
			i++
		}
	}
	if strings.TrimSpace(s[start:]) != "" {
		out = append(out, s[start:])
	}
	return out
}

var dollarTag = regexp.MustCompile(`^\$[A-Za-z_]*\$`)

func (rs resultSet) typeAt(i int) string {
	if i < len(rs.Types) {
		return rs.Types[i]
	}
	return ""
}

// cell convierte un valor del driver en algo que JSON y la cuadrícula entienden.
func cell(v any, dbType string) any {
	switch x := v.(type) {
	case nil:
		return nil
	case []byte:
		if dbType == "uniqueidentifier" && len(x) == 16 {
			// SQL Server guarda los GUID con los tres primeros grupos al revés.
			b := []byte{x[3], x[2], x[1], x[0], x[5], x[4], x[7], x[6]}
			b = append(b, x[8:]...)
			h := strings.ToUpper(hex.EncodeToString(b))
			return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
		}
		if utf8.Valid(x) {
			return string(x)
		}
		return "0x" + strings.ToUpper(hex.EncodeToString(x))
	case time.Time:
		if x.Hour() == 0 && x.Minute() == 0 && x.Second() == 0 && x.Nanosecond() == 0 && (dbType == "date") {
			return x.Format("2006-01-02")
		}
		return x.Format("2006-01-02 15:04:05.000")
	case bool:
		if x {
			return 1
		}
		return 0
	case int64:
		if x > 1<<53 || x < -(1<<53) {
			return strconv.FormatInt(x, 10)
		}
		return x
	}
	return v
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

var goLine = regexp.MustCompile(`(?im)^\s*GO\s*;?\s*$`)

// splitGO parte un script de SQL Server en lotes por las líneas «GO».
func splitGO(s string) []string {
	return goLine.Split(s, -1)
}

// REPLACE escribe solo como sentencia (REPLACE INTO de MySQL); REPLACE( es la función.
var writeWords = regexp.MustCompile(`(?i)\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|RENAME|CALL|SET\s+IDENTITY_INSERT)\b|\bREPLACE\s+[A-Za-z_\x60]`)
var commentsAndStrings = regexp.MustCompile(`(?s)--[^\n]*|/\*.*?\*/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\[[^\]]*\]`)

// firstWriteStatement devuelve la primera palabra que modifica datos o
// estructura, sin mirar comentarios ni textos entre comillas.
func firstWriteStatement(s string) string {
	clean := commentsAndStrings.ReplaceAllString(s, " ")
	if m := writeWords.FindString(clean); m != "" {
		w := strings.ToUpper(strings.Join(strings.Fields(m), " "))
		if strings.HasPrefix(w, "REPLACE") {
			return "REPLACE"
		}
		return w
	}
	return ""
}

// ── Cancelar

type cancelIn struct {
	QueryID string `json:"queryId"`
}

func handleCancel(in cancelIn) (any, error) {
	runningMu.Lock()
	cancel, ok := running[in.QueryID]
	runningMu.Unlock()
	if ok {
		cancel()
	}
	return map[string]bool{"ok": ok}, nil
}

// ── Explorador de objetos

type schemaIn struct {
	Conn     Conn   `json:"conn"`
	Database string `json:"database"` // vacío: lista las bases; con valor: sus objetos
}

type object struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Kind   string `json:"kind"` // table | view | proc
}

func handleSchema(in schemaIn) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := in.Conn
	if in.Database == "" {
		db, err := open(ctx, c, "")
		if err != nil {
			return nil, err
		}
		q := map[string]string{
			"mssql":    "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name",
			"postgres": "SELECT datname FROM pg_database WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname",
			"mysql":    "SHOW DATABASES",
			"sqlite":   "SELECT 'main'",
		}[c.Engine]
		names, err := strings1(ctx, db, q)
		if err != nil {
			return nil, err
		}
		return map[string]any{"databases": names}, nil
	}

	db, err := open(ctx, c, in.Database)
	if err != nil {
		return nil, err
	}
	var q string
	switch c.Engine {
	case "mssql":
		q = `SELECT s.name, o.name, CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' ELSE 'proc' END
		     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
		     WHERE o.type IN ('U','V','P') AND o.is_ms_shipped = 0 ORDER BY 3, 1, 2`
	case "postgres":
		q = `SELECT table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END
		     FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')
		     UNION ALL
		     SELECT routine_schema, routine_name, 'proc' FROM information_schema.routines
		     WHERE routine_schema NOT IN ('pg_catalog','information_schema')
		     ORDER BY 3, 1, 2`
	case "mysql":
		q = `SELECT table_schema, table_name, CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END
		     FROM information_schema.tables WHERE table_schema = DATABASE()
		     UNION ALL
		     SELECT routine_schema, routine_name, 'proc' FROM information_schema.routines WHERE routine_schema = DATABASE()
		     ORDER BY 3, 1, 2`
	case "sqlite":
		q = `SELECT '', name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
	}
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	objs := []object{}
	for rows.Next() {
		var o object
		if err := rows.Scan(&o.Schema, &o.Name, &o.Kind); err != nil {
			return nil, err
		}
		objs = append(objs, o)
	}
	return map[string]any{"objects": objs}, rows.Err()
}

func strings1(ctx context.Context, db *sql.DB, q string) ([]string, error) {
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
