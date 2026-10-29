// Puente de Estudio SQL: abre las conexiones a las bases de datos y responde
// al mod por HTTP sobre un socket Unix privado. El mod no puede abrir
// conexiones TCP por sí mismo; este programa sí.
//
// Al arrancar imprime una línea JSON con la ruta del socket:
//
//	{"socket":"/tmp/estudio-sql-123/puente.sock"}
//
// y se cierra solo cuando el proceso que lo lanzó desaparece.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func main() {
	dir, err := os.MkdirTemp("", "estudio-sql-")
	if err != nil {
		fatal(err)
	}
	_ = os.Chmod(dir, 0o700)
	sock := filepath.Join(dir, "puente.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		fatal(err)
	}
	defer os.RemoveAll(dir)

	mux := http.NewServeMux()
	route(mux, "/ping", func(struct{}) (any, error) {
		return map[string]any{"ok": true, "version": version, "os": runtime.GOOS}, nil
	})
	route(mux, "/test", handleTest)
	route(mux, "/query", handleQuery)
	route(mux, "/cancel", handleCancel)
	route(mux, "/schema", handleSchema)
	route(mux, "/secret/set", handleSecretSet)
	route(mux, "/secret/delete", handleSecretDelete)
	route(mux, "/close", handleClose)

	line, _ := json.Marshal(map[string]string{"socket": sock})
	fmt.Println(string(line))

	quit := func() {
		closeAll()
		_ = os.RemoveAll(dir)
		os.Exit(0)
	}
	go watchParent(quit)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() { <-sig; quit() }()
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	_ = srv.Serve(ln)
}

const version = "0.1.0"

// route registra un manejador JSON → JSON. Los errores viajan como
// {"error": "..."} con estado 200, para que el mod los muestre tal cual.
func route[In any](mux *http.ServeMux, path string, fn func(In) (any, error)) {
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		var in In
		if r.Body != nil {
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
			if err := dec.Decode(&in); err != nil && err.Error() != "EOF" {
				writeJSON(w, map[string]string{"error": "Petición inválida: " + err.Error()})
				return
			}
		}
		out, err := fn(in)
		if err != nil {
			writeJSON(w, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, out)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func watchParent(onGone func()) {
	parent := os.Getppid()
	for range time.Tick(2 * time.Second) {
		if os.Getppid() != parent {
			onGone()
		}
	}
}

func fatal(err error) {
	line, _ := json.Marshal(map[string]string{"error": err.Error()})
	fmt.Println(string(line))
	os.Exit(1)
}
