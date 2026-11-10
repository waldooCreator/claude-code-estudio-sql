package main

import (
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMssqlServidor(t *testing.T) {
	casos := []struct{ servidor, puerto, host, port, instancia string }{
		{"db.ejemplo.local", "1433", "db.ejemplo.local", "1433", ""},
		{"db.ejemplo.local", "", "db.ejemplo.local", "", ""},
		{`EQUIPO\SQLEXPRESS`, "1433", "EQUIPO", "", "SQLEXPRESS"},
		{`EQUIPO\SQLEXPRESS`, "", "EQUIPO", "", "SQLEXPRESS"},
		{`EQUIPO\SQLEXPRESS`, "50123", "EQUIPO", "50123", "SQLEXPRESS"},
		{`.\SQLEXPRESS`, "1433", "localhost", "", "SQLEXPRESS"},
		{`(local)\CONTA`, "", "localhost", "", "CONTA"},
		{` 10.0.0.5\VENTAS `, " 1433 ", "10.0.0.5", "", "VENTAS"},
	}
	for _, c := range casos {
		h, p, i := mssqlServidor(c.servidor, c.puerto)
		if h != c.host || p != c.port || i != c.instancia {
			t.Errorf("mssqlServidor(%q, %q) = %q, %q, %q; quería %q, %q, %q", c.servidor, c.puerto, h, p, i, c.host, c.port, c.instancia)
		}
	}
}

func dsnMssql(t *testing.T, c Conn, host, port, instancia string) *url.URL {
	t.Helper()
	driver, dsn, err := dsnFor(c, host, port, instancia, "Ventas")
	if err != nil || driver != "sqlserver" {
		t.Fatalf("dsnFor: %v %q", err, driver)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("DSN inválido %q: %v", dsn, err)
	}
	if u.Query().Get("database") != "Ventas" {
		t.Errorf("falta la base en %q", dsn)
	}
	return u
}

func TestDsnMssqlInstancia(t *testing.T) {
	c := Conn{Engine: "mssql", User: "ana", Password: "s3cr3t@:/"}
	// Instancia sin puerto: va como ruta y sin puerto, para que pregunte al SQL Browser.
	u := dsnMssql(t, c, "EQUIPO", "", "SQLEXPRESS")
	if u.Host != "EQUIPO" || u.Path != "/SQLEXPRESS" {
		t.Errorf("con instancia: host %q ruta %q", u.Host, u.Path)
	}
	if p, _ := u.User.Password(); u.User.Username() != "ana" || p != "s3cr3t@:/" {
		t.Errorf("usuario o contraseña mal codificados: %v", u.User)
	}
	// Con puerto propio, el puerto manda.
	u = dsnMssql(t, c, "EQUIPO", "50123", "SQLEXPRESS")
	if u.Host != "EQUIPO:50123" {
		t.Errorf("con puerto propio: host %q", u.Host)
	}
	// Sin instancia: equipo:puerto, como siempre.
	u = dsnMssql(t, c, "db.ejemplo.local", "1433", "")
	if u.Host != "db.ejemplo.local:1433" || u.Path != "" {
		t.Errorf("sin instancia: host %q ruta %q", u.Host, u.Path)
	}
}

func TestDsnMssqlSesionWindows(t *testing.T) {
	// Sin usuario ni contraseña no va «:@» en el URL: el driver usa SSPI.
	u := dsnMssql(t, Conn{Engine: "mssql"}, "EQUIPO", "", "SQLEXPRESS")
	if u.User != nil {
		t.Errorf("con sesión de Windows no debe ir usuario: %v", u.User)
	}
	// DOMINIO\usuario viaja entero.
	u = dsnMssql(t, Conn{Engine: "mssql", User: `OFICINA\ana`, Password: "x"}, "EQUIPO", "1433", "")
	if u.User.Username() != `OFICINA\ana` {
		t.Errorf("usuario de dominio: %q", u.User.Username())
	}
}

func TestUsuarioVacioFueraDeWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("en Windows el usuario vacío es la sesión de Windows")
	}
	_, err := open(t.Context(), Conn{Engine: "mssql", Host: "falso.invalid"}, "")
	if err == nil || !strings.Contains(err.Error(), "sesión de Windows") {
		t.Errorf("quería el aviso de la sesión de Windows, llegó %v", err)
	}
}

func TestExpandHome(t *testing.T) {
	casa := homeDir()
	if got := expandHome("~/.ssh/id_ed25519"); got != filepath.Join(casa, ".ssh", "id_ed25519") {
		t.Errorf("~/: %q", got)
	}
	if got := expandHome(`~\.ssh\id_ed25519`); !strings.HasPrefix(got, casa) {
		t.Errorf(`~\: %q`, got)
	}
	if got := expandHome("/srv/datos.db"); got != "/srv/datos.db" {
		t.Errorf("ruta absoluta cambiada: %q", got)
	}
}

func TestDsnSqliteRutaWindows(t *testing.T) {
	_, dsn, err := dsnFor(Conn{Engine: "sqlite", Host: filepath.FromSlash("/srv/datos/tienda.db"), ReadOnly: true}, "", "", "", "")
	if err != nil || !strings.HasPrefix(dsn, "file:/srv/datos/tienda.db?mode=ro") {
		t.Errorf("sqlite: %q %v", dsn, err)
	}
}
