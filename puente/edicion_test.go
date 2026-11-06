package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Edición en la cuadrícula contra motores de verdad. SQLite corre siempre;
// los demás, si sus variables apuntan a un servidor de prueba (host:puerto):
//
//	ESQL_MSSQL=127.0.0.1:51433 ESQL_PG=127.0.0.1:55432 ESQL_MY=127.0.0.1:53306 go test ./...
//
// Usuario sa / postgres / root y contraseña en ESQL_CLAVE_MSSQL, ESQL_CLAVE_PG, ESQL_CLAVE_MY.

type motorPrueba struct {
	conn  Conn
	base  string
	crear []string
}

func motores(t *testing.T) map[string]motorPrueba {
	out := map[string]motorPrueba{}
	archivo := filepath.Join(t.TempDir(), "prueba.db")
	out["sqlite"] = motorPrueba{
		conn: Conn{Engine: "sqlite", Host: archivo},
		crear: []string{
			`CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT, saldo REAL, creado TEXT, doble REAL GENERATED ALWAYS AS (saldo * 2))`,
			`CREATE TABLE sinclave (a INTEGER, b TEXT)`,
			`CREATE VIEW vclientes AS SELECT id, nombre FROM clientes`,
		},
	}
	hostPuerto := func(env string) (string, string, bool) {
		v := os.Getenv(env)
		if v == "" {
			return "", "", false
		}
		i := strings.LastIndex(v, ":")
		return v[:i], v[i+1:], true
	}
	if h, p, ok := hostPuerto("ESQL_MSSQL"); ok {
		out["mssql"] = motorPrueba{
			conn: Conn{Engine: "mssql", Host: h, Port: p, User: "sa", Password: os.Getenv("ESQL_CLAVE_MSSQL"), Encrypt: "false"},
			base: "master",
			crear: []string{
				`IF DB_ID('prueba_edicion') IS NOT NULL BEGIN ALTER DATABASE prueba_edicion SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE prueba_edicion END`,
				`CREATE DATABASE prueba_edicion`,
				`USE prueba_edicion`,
				`CREATE TABLE dbo.clientes (id int IDENTITY PRIMARY KEY, nombre nvarchar(50), saldo decimal(12,2), creado datetime2(3), doble AS saldo * 2)`,
				`CREATE TABLE dbo.sinclave (a int, b nvarchar(10))`,
				`CREATE VIEW dbo.vclientes AS SELECT id, nombre FROM dbo.clientes`,
			},
		}
	}
	if h, p, ok := hostPuerto("ESQL_PG"); ok {
		out["postgres"] = motorPrueba{
			conn: Conn{Engine: "postgres", Host: h, Port: p, User: "postgres", Password: os.Getenv("ESQL_CLAVE_PG")},
			base: "postgres",
			crear: []string{
				`DROP VIEW IF EXISTS vclientes`, `DROP TABLE IF EXISTS clientes`, `DROP TABLE IF EXISTS sinclave`,
				`CREATE TABLE clientes (id serial PRIMARY KEY, nombre varchar(50), saldo numeric(12,2), creado timestamp(3), doble numeric GENERATED ALWAYS AS (saldo * 2) STORED)`,
				`CREATE TABLE sinclave (a int, b varchar(10))`,
				`CREATE VIEW vclientes AS SELECT id, nombre FROM clientes`,
			},
		}
	}
	if h, p, ok := hostPuerto("ESQL_MY"); ok {
		out["mysql"] = motorPrueba{
			conn: Conn{Engine: "mysql", Host: h, Port: p, User: "root", Password: os.Getenv("ESQL_CLAVE_MY")},
			base: "prueba",
			crear: []string{
				`DROP VIEW IF EXISTS vclientes`, `DROP TABLE IF EXISTS clientes`, `DROP TABLE IF EXISTS sinclave`,
				`CREATE TABLE clientes (id int AUTO_INCREMENT PRIMARY KEY, nombre varchar(50), saldo decimal(12,2), creado datetime(3), doble decimal(14,2) AS (saldo * 2))`,
				`CREATE TABLE sinclave (a int, b varchar(10))`,
				`CREATE VIEW vclientes AS SELECT id, nombre FROM clientes`,
			},
		}
	}
	return out
}

func consultar(t *testing.T, m motorPrueba, q string) resultSet {
	t.Helper()
	r, err := handleQuery(queryIn{Conn: m.conn, Database: m.base, SQL: q, MaxRows: 100})
	if err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	out := r.(queryOut)
	if out.Failed || len(out.Results) == 0 {
		t.Fatalf("%s: %+v", q, out.Messages)
	}
	return out.Results[0]
}

func editable(t *testing.T, m motorPrueba, q string) (editableOut, resultSet) {
	t.Helper()
	rs := consultar(t, m, q)
	r, err := handleEditable(editableIn{Conn: m.conn, Database: m.base, SQL: q, Columns: rs.Columns})
	if err != nil {
		t.Fatalf("editable %s: %v", q, err)
	}
	return r.(editableOut), rs
}

func ptr(s string) *string { return &s }

func TestEdicion(t *testing.T) {
	for nombre, m := range motores(t) {
		t.Run(nombre, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			db, err := open(ctx, m.conn, m.base)
			if err != nil {
				t.Fatal(err)
			}
			conn, err := db.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, q := range m.crear {
				if _, err := conn.ExecContext(ctx, q); err != nil {
					t.Fatalf("%s: %v", q, err)
				}
			}
			conn.Close()
			if nombre == "mssql" {
				m.base = "prueba_edicion"
			}
			for _, q := range []string{
				`INSERT INTO clientes (nombre, saldo, creado) VALUES ('Ana', 10.50, '2026-11-01 08:30:00')`,
				`INSERT INTO clientes (nombre, saldo, creado) VALUES ('Luis', 20, '2026-11-02 09:00:00')`,
			} {
				consultar(t, m, q+"; SELECT 1 AS listo")
			}
			tabla := "clientes"
			if nombre == "mssql" {
				tabla = "dbo.clientes"
			}

			// Una tabla con su clave: editable; la columna calculada no.
			info, rs := editable(t, m, "SELECT * FROM "+tabla+" ORDER BY id")
			if !info.Editable {
				t.Fatalf("SELECT *: no editable: %s", info.Reason)
			}
			if len(info.Key) != 1 || info.KeyColumns[0] != "id" || rs.Columns[info.Key[0]] != "id" {
				t.Fatalf("clave: %+v", info)
			}
			if info.Sources[1] != "nombre" || info.Sources[4] != "" {
				t.Fatalf("columnas: %q", info.Sources)
			}

			// Sin la clave, de varias tablas, de una vista o en solo lectura: no.
			for q, motivo := range map[string]string{
				"SELECT nombre, saldo FROM " + tabla:                                            "id",
				"SELECT c.nombre, s.b, c.id FROM " + tabla + " c JOIN sinclave s ON s.a = c.id": "",
				"SELECT * FROM sinclave":                                                        "clave primaria",
				"SELECT COUNT(*) AS n FROM " + tabla:                                            "",
			} {
				info, _ := editable(t, m, q)
				if info.Editable || !strings.Contains(info.Reason, motivo) {
					t.Errorf("%s: editable=%v motivo=%q", q, info.Editable, info.Reason)
				}
			}
			// Una vista: SQL Server la resuelve hasta su tabla base y se edita esa tabla, como en SSMS;
			// los demás motores piden consultar la tabla.
			if v, _ := editable(t, m, "SELECT id, nombre FROM vclientes"); nombre == "mssql" {
				if !v.Editable || v.Table.Name != "clientes" {
					t.Errorf("vista en SQL Server: %+v", v)
				}
			} else if v.Editable {
				t.Errorf("vista: editable en %s", nombre)
			}
			ro := m
			ro.conn.ReadOnly = true
			if r, _ := handleEditable(editableIn{Conn: ro.conn, Database: m.base, SQL: "SELECT * FROM " + tabla, Columns: rs.Columns}); r.(editableOut).Editable {
				t.Error("solo lectura: editable")
			}

			fila := rs.Rows[0]
			base := updateIn{Conn: m.conn, Database: m.base, Table: info.Table, Key: []keyVal{{Column: "id", Value: fila[0]}}}

			// Vista previa: el UPDATE con los valores escritos, sin ejecutarlo.
			u := base
			u.Column, u.Value, u.Original, u.DryRun = "nombre", ptr("Ana María"), fila[1], true
			r, err := handleUpdate(u)
			if err != nil {
				t.Fatal(err)
			}
			vista := r.(map[string]any)["sql"].(string)
			if !strings.Contains(vista, "Ana María") || !strings.Contains(vista, "WHERE") {
				t.Fatalf("vista previa: %s", vista)
			}
			if v := consultar(t, m, "SELECT nombre FROM "+tabla+" WHERE id = 1").Rows[0][0]; v != "Ana" {
				t.Fatalf("la vista previa cambió el dato: %v", v)
			}

			// Guardar de verdad: texto, número, fecha y NULL.
			for _, c := range []struct {
				col   string
				valor *string
				ver   any
				antes int
			}{
				{"nombre", ptr("Ana María"), "Ana María", 1},
				{"saldo", ptr("99.25"), nil, 2},
				{"creado", ptr("2026-12-24 18:00:00"), nil, 3},
				{"nombre", nil, nil, 1},
			} {
				actual := consultar(t, m, "SELECT * FROM "+tabla+" WHERE id = 1").Rows[0]
				u := base
				u.Column, u.Value, u.Original = c.col, c.valor, actual[c.antes]
				r, err := handleUpdate(u)
				if err != nil {
					t.Fatalf("%s = %v: %v", c.col, c.valor, err)
				}
				nuevo := r.(map[string]any)["value"]
				if c.valor == nil && nuevo != nil {
					t.Errorf("%s: esperaba NULL, quedó %v", c.col, nuevo)
				}
				if c.ver != nil && nuevo != c.ver {
					t.Errorf("%s: esperaba %v, quedó %v", c.col, c.ver, nuevo)
				}
				if c.col == "saldo" && !strings.Contains(fmt.Sprint(nuevo), "99.25") {
					t.Errorf("saldo: quedó %v", nuevo)
				}
			}

			// Un valor que el motor rechaza: el error del motor llega tal cual y no se guarda nada.
			actual := consultar(t, m, "SELECT * FROM "+tabla+" WHERE id = 2").Rows[0]
			u = updateIn{Conn: m.conn, Database: m.base, Table: info.Table, Key: []keyVal{{Column: "id", Value: actual[0]}}, Column: "saldo", Value: ptr("no es un número"), Original: actual[2]}
			if nombre != "sqlite" {
				if _, err := handleUpdate(u); err == nil {
					t.Error("saldo = texto: esperaba un error del motor")
				} else {
					t.Logf("error del motor (bien): %v", err)
				}
			}

			// Otro lo cambió mientras se editaba: no se pisa.
			u = updateIn{Conn: m.conn, Database: m.base, Table: info.Table, Key: []keyVal{{Column: "id", Value: actual[0]}}, Column: "nombre", Value: ptr("Pedro"), Original: "Lucho"}
			if _, err := handleUpdate(u); err == nil || !strings.Contains(err.Error(), "Alguien cambió") {
				t.Errorf("valor cambiado por otro: %v", err)
			}
			// La fila ya no existe.
			u.Key = []keyVal{{Column: "id", Value: float64(999)}}
			if _, err := handleUpdate(u); err == nil || !strings.Contains(err.Error(), "ya no existe") {
				t.Errorf("fila borrada: %v", err)
			}
			if v := consultar(t, m, "SELECT nombre FROM "+tabla+" WHERE id = 2").Rows[0][0]; v != "Luis" {
				t.Errorf("Luis cambió: %v", v)
			}
			// En solo lectura, ni con la petición armada a mano.
			u = updateIn{Conn: ro.conn, Database: m.base, Table: info.Table, Key: []keyVal{{Column: "id", Value: actual[0]}}, Column: "nombre", Value: ptr("Pedro"), Original: "Luis"}
			if _, err := handleUpdate(u); err == nil {
				t.Error("solo lectura: guardó")
			}
		})
	}
}
