// Puente de Estudio SQL: abre las conexiones a las bases de datos y responde
// al mod por HTTP. El mod no puede abrir conexiones TCP por sí mismo; este
// programa sí.
//
// En Linux y macOS escucha en un socket Unix privado y al arrancar imprime
// una línea JSON con su ruta:
//
//	{"socket":"/tmp/estudio-sql-123/puente.sock"}
//
// En Windows (o con -tcp, o con ESTUDIO_SQL_TCP=1, o si el socket no se pudo
// crear) escucha en 127.0.0.1 en un puerto libre y exige en cada pedido la
// cabecera X-Estudio-Token con un token aleatorio que solo conoce el mod:
//
//	{"url":"http://127.0.0.1:50123","token":"…"}
//
// Se cierra solo cuando el proceso que lo lanzó desaparece.
package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
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

// cabeceraToken es la cabecera con la que el mod se identifica en modo TCP.
const cabeceraToken = "X-Estudio-Token"

// transporte dice cómo escucha el puente: "socket" o "tcp".
var transporte = "socket"

// quiereTCP: en Windows siempre (no todo motor habla HTTP por un socket Unix
// allí); en los demás, si se pide con -tcp o ESTUDIO_SQL_TCP=1.
func quiereTCP(args []string) bool {
	if runtime.GOOS == "windows" || os.Getenv("ESTUDIO_SQL_TCP") == "1" {
		return true
	}
	for _, a := range args {
		if a == "-tcp" || a == "--tcp" {
			return true
		}
	}
	return false
}

// escuchar abre el socket Unix o, si se pide TCP o el socket falla, un puerto
// local. Devuelve lo que hay que imprimir para el mod y el token (vacío con socket).
func escuchar(tcp bool) (ln net.Listener, anuncio map[string]string, token, dir string, err error) {
	if !tcp {
		dir, err = os.MkdirTemp("", "estudio-sql-")
		if err == nil {
			_ = os.Chmod(dir, 0o700)
			sock := filepath.Join(dir, "puente.sock")
			if ln, err = net.Listen("unix", sock); err == nil {
				return ln, map[string]string{"socket": sock}, "", dir, nil
			}
			_ = os.RemoveAll(dir)
			dir = ""
		}
	}
	ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, "", "", err
	}
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		ln.Close()
		return nil, nil, "", "", err
	}
	token = hex.EncodeToString(b)
	transporte = "tcp"
	return ln, map[string]string{"url": "http://" + ln.Addr().String(), "token": token}, token, "", nil
}

// conToken rechaza todo pedido que no traiga el token (solo en modo TCP: el
// puerto lo alcanza cualquier programa del equipo; el socket, solo el dueño).
func conToken(token string, h http.Handler) http.Handler {
	if token == "" {
		return h
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get(cabeceraToken)), []byte(token)) != 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Falta el token del puente."})
			return
		}
		h.ServeHTTP(w, r)
	})
}

func main() {
	ln, anuncio, token, dir, err := escuchar(quiereTCP(os.Args[1:]))
	if err != nil {
		fatal(err)
	}
	if dir != "" {
		defer os.RemoveAll(dir)
	}

	mux := http.NewServeMux()
	route(mux, "/ping", func(struct{}) (any, error) {
		return map[string]any{"ok": true, "version": version, "os": runtime.GOOS}, nil
	})
	route(mux, "/diagnostico", handleDiagnostico)
	route(mux, "/test", handleTest)
	route(mux, "/query", handleQuery)
	route(mux, "/cancel", handleCancel)
	route(mux, "/schema", handleSchema)
	route(mux, "/editable", handleEditable)
	route(mux, "/update", handleUpdate)
	route(mux, "/secret/set", handleSecretSet)
	route(mux, "/secret/delete", handleSecretDelete)
	route(mux, "/close", handleClose)

	line, _ := json.Marshal(anuncio)
	fmt.Println(string(line))

	quit := func() {
		closeAll()
		if dir != "" {
			_ = os.RemoveAll(dir)
		}
		os.Exit(0)
	}
	go watchParent(quit)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() { <-sig; quit() }()
	srv := &http.Server{Handler: conToken(token, mux), ReadHeaderTimeout: 10 * time.Second}
	_ = srv.Serve(ln)
}

const version = "0.2.0"

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

// handleDiagnostico cuenta lo que el comando de diagnóstico del mod muestra.
func handleDiagnostico(struct{}) (any, error) {
	ok, detalle := llaveroDisponible()
	return map[string]any{
		"version":    version,
		"os":         runtime.GOOS,
		"arch":       runtime.GOARCH,
		"transporte": transporte,
		"llavero":    map[string]any{"ok": ok, "nombre": nombreLlavero(), "detalle": detalle},
	}, nil
}

func fatal(err error) {
	line, _ := json.Marshal(map[string]string{"error": err.Error()})
	fmt.Println(string(line))
	os.Exit(1)
}
