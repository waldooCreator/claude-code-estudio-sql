package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// En modo TCP todo pedido sin el token se rechaza; con él, pasa.
func TestTokenEnModoTCP(t *testing.T) {
	ln, anuncio, token, dir, err := escuchar(true)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if dir != "" || token == "" || !strings.HasPrefix(anuncio["url"], "http://127.0.0.1:") || anuncio["token"] != token {
		t.Fatalf("anuncio inesperado: %v", anuncio)
	}
	mux := http.NewServeMux()
	route(mux, "/ping", func(struct{}) (any, error) { return map[string]bool{"ok": true}, nil })
	srv := httptest.NewUnstartedServer(conToken(token, mux))
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	defer srv.Close()

	pedir := func(tok string) (int, map[string]any) {
		req, _ := http.NewRequest("POST", anuncio["url"]+"/ping", strings.NewReader("{}"))
		if tok != "" {
			req.Header.Set(cabeceraToken, tok)
		}
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		return r.StatusCode, m
	}
	if code, m := pedir(""); code != http.StatusForbidden || m["error"] == nil {
		t.Errorf("sin token: %d %v", code, m)
	}
	if code, _ := pedir("otro"); code != http.StatusForbidden {
		t.Errorf("token equivocado: %d", code)
	}
	if code, m := pedir(token); code != 200 || m["ok"] != true {
		t.Errorf("con token: %d %v", code, m)
	}
}
