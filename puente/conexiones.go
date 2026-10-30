package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/microsoft/go-mssqldb"
	"github.com/zalando/go-keyring"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
	_ "modernc.org/sqlite"
)

// Conn es una conexión tal como la guarda el mod. La contraseña no viaja:
// el puente la lee del llavero del sistema por el id de la conexión.
type Conn struct {
	ID       string   `json:"id"`
	Engine   string   `json:"engine"` // mssql | postgres | mysql | sqlite
	Host     string   `json:"host"`   // o la ruta del archivo en SQLite
	Port     string   `json:"port"`
	User     string   `json:"user"`
	Password string   `json:"password,omitempty"` // solo para probar antes de guardar
	Database string   `json:"database"`
	ReadOnly bool     `json:"readOnly"`
	Encrypt  string   `json:"encrypt"` // SQL Server: "", "true", "false"; vacío = opcional con certificado no verificado
	SSH      *SSHConf `json:"ssh,omitempty"`
}

type SSHConf struct {
	Host string `json:"host"` // usuario@equipo o equipo
	Port string `json:"port"`
	User string `json:"user"`
	Key  string `json:"key"` // ruta de la llave privada; vacío = agente SSH o llaves por defecto
}

const keyringService = "estudio-sql"

type pooled struct {
	db     *sql.DB
	tunnel *tunnel
}

var (
	poolMu sync.Mutex
	pool   = map[string]*pooled{}
)

func (c Conn) poolKey(database string) string {
	b, _ := json.Marshal(struct {
		C  Conn
		DB string
	}{c, database})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// open devuelve un *sql.DB listo para usar, reutilizando el de la misma
// conexión y base si ya existe.
func open(ctx context.Context, c Conn, database string) (*sql.DB, error) {
	if database == "" {
		database = c.Database
	}
	if c.Password == "" && c.Engine != "sqlite" && c.ID != "" {
		if p, err := keyring.Get(keyringService, c.ID); err == nil {
			c.Password = p
		}
	}
	key := c.poolKey(database)
	poolMu.Lock()
	if p, ok := pool[key]; ok {
		if p.tunnel.alive() {
			poolMu.Unlock()
			return p.db, nil
		}
		// El túnel murió (red caída, equipo suspendido): se descarta y se abre otro.
		p.db.Close()
		delete(pool, key)
	}
	poolMu.Unlock()

	host, port := c.Host, c.Port
	if port == "" {
		port = defaultPort(c.Engine)
	}
	var tun *tunnel
	if c.SSH != nil && c.SSH.Host != "" && c.Engine != "sqlite" {
		t, err := openTunnel(*c.SSH, net.JoinHostPort(host, port))
		if err != nil {
			return nil, err
		}
		tun = t
		host, port = "127.0.0.1", strconv.Itoa(t.port)
	}

	driver, dsn, err := dsnFor(c, host, port, database)
	if err != nil {
		tun.Close()
		return nil, err
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		tun.Close()
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	pctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.PingContext(pctx); err != nil {
		db.Close()
		tun.Close()
		return nil, friendly(err)
	}
	poolMu.Lock()
	pool[key] = &pooled{db: db, tunnel: tun}
	poolMu.Unlock()
	return db, nil
}

func defaultPort(engine string) string {
	switch engine {
	case "mssql":
		return "1433"
	case "postgres":
		return "5432"
	case "mysql":
		return "3306"
	}
	return ""
}

func dsnFor(c Conn, host, port, database string) (string, string, error) {
	switch c.Engine {
	case "mssql":
		q := url.Values{}
		if database != "" {
			q.Set("database", database)
		}
		switch c.Encrypt {
		case "true":
			q.Set("encrypt", "true")
		case "false":
			q.Set("encrypt", "disable")
		default:
			q.Set("encrypt", "true")
			q.Set("TrustServerCertificate", "true")
		}
		q.Set("app name", "Estudio SQL")
		u := url.URL{Scheme: "sqlserver", User: url.UserPassword(c.User, c.Password), Host: net.JoinHostPort(host, port), RawQuery: q.Encode()}
		return "sqlserver", u.String(), nil
	case "postgres":
		db := database
		if db == "" {
			db = "postgres"
		}
		u := url.URL{Scheme: "postgres", User: url.UserPassword(c.User, c.Password), Host: net.JoinHostPort(host, port), Path: "/" + db, RawQuery: "sslmode=prefer&application_name=Estudio%20SQL"}
		return "pgx", u.String(), nil
	case "mysql":
		cfg := mysql.NewConfig()
		cfg.User, cfg.Passwd, cfg.Net, cfg.Addr, cfg.DBName = c.User, c.Password, "tcp", net.JoinHostPort(host, port), database
		cfg.ParseTime = true
		cfg.MultiStatements = true
		cfg.AllowNativePasswords = true
		return "mysql", cfg.FormatDSN(), nil
	case "sqlite":
		path := expandHome(c.Host)
		if path == "" {
			return "", "", errors.New("Falta la ruta del archivo de SQLite.")
		}
		mode := "rwc"
		if c.ReadOnly {
			mode = "ro"
		}
		return "sqlite", "file:" + path + "?mode=" + mode + "&_pragma=busy_timeout(5000)", nil
	}
	return "", "", fmt.Errorf("Motor desconocido: %q", c.Engine)
}

// friendly traduce los errores de red más comunes a algo que se entienda.
func friendly(err error) error {
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return fmt.Errorf("El servidor rechazó la conexión. Revisa la dirección y el puerto, y que el motor esté encendido. (%s)", s)
	case strings.Contains(s, "i/o timeout"), strings.Contains(s, "deadline exceeded"):
		return fmt.Errorf("El servidor no respondió a tiempo. Revisa la dirección, la VPN o Tailscale, y el firewall. (%s)", s)
	case strings.Contains(s, "connection reset by peer"), strings.Contains(s, "broken pipe"), s == "EOF", strings.HasSuffix(s, ": EOF"):
		return fmt.Errorf("Se perdió la conexión con el servidor (la red o el túnel SSH se cayó). Vuelve a ejecutar: se abre una conexión nueva. (%s)", s)
	case strings.Contains(s, "no such host"):
		return fmt.Errorf("No se encontró el servidor por ese nombre. Revisa que esté bien escrito o usa la IP. (%s)", s)
	case strings.Contains(strings.ToLower(s), "login failed"), strings.Contains(s, "password authentication failed"), strings.Contains(s, "Access denied"):
		return fmt.Errorf("Usuario o contraseña incorrectos. (%s)", s)
	}
	return err
}

func closeAll() {
	poolMu.Lock()
	defer poolMu.Unlock()
	for k, p := range pool {
		p.db.Close()
		p.tunnel.Close()
		delete(pool, k)
	}
}

// ── Túnel SSH: escucha en un puerto local y reenvía cada conexión al
// servidor de base de datos a través del equipo intermedio.

type tunnel struct {
	ln     net.Listener
	client *ssh.Client
	port   int
	once   sync.Once
	dead   chan struct{}
}

// Un túnel sin tráfico no se entera de que la red se cayó: cada tanto se le
// pregunta al servidor SSH si sigue ahí, y si no contesta se da por muerto.
const (
	keepaliveEvery   = 15 * time.Second
	keepaliveTimeout = 10 * time.Second
	sshDialTimeout   = 15 * time.Second
)

func (t *tunnel) Close() {
	if t == nil {
		return
	}
	t.once.Do(func() {
		close(t.dead)
		t.ln.Close()
		t.client.Close()
	})
}

// alive dice si el túnel sigue sirviendo; sin túnel (conexión directa) siempre.
func (t *tunnel) alive() bool {
	if t == nil {
		return true
	}
	select {
	case <-t.dead:
		return false
	default:
		return true
	}
}

// withTimeout corre fn y devuelve su error, o se rinde al pasar d.
func withTimeout(d time.Duration, fn func() error) error {
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-time.After(d):
		return errors.New("el servidor SSH no respondió a tiempo")
	}
}

func (t *tunnel) keepalive() {
	tick := time.NewTicker(keepaliveEvery)
	defer tick.Stop()
	for {
		select {
		case <-t.dead:
			return
		case <-tick.C:
			err := withTimeout(keepaliveTimeout, func() error {
				_, _, err := t.client.SendRequest("keepalive@openssh.com", true, nil)
				return err
			})
			if err != nil {
				t.Close()
				return
			}
		}
	}
}

func openTunnel(s SSHConf, target string) (*tunnel, error) {
	user, host := s.User, s.Host
	if i := strings.LastIndex(host, "@"); i >= 0 {
		user, host = host[:i], host[i+1:]
	}
	if user == "" {
		user = os.Getenv("USER")
	}
	port := s.Port
	if port == "" {
		port = "22"
	}
	addr := net.JoinHostPort(host, port)

	auths, err := sshAuth(s.Key)
	if err != nil {
		return nil, err
	}
	khPath := filepath.Join(homeDir(), ".ssh", "known_hosts")
	hostKey, err := knownhosts.New(khPath)
	if err != nil {
		return nil, fmt.Errorf("No pude leer %s para verificar el equipo SSH. Conéctate una vez con «ssh %s@%s» para registrarlo. (%v)", khPath, user, host, err)
	}
	cfg := &ssh.ClientConfig{User: user, Auth: auths, HostKeyCallback: hostKey, Timeout: 15 * time.Second}
	// Como hace ssh: pedir primero los tipos de llave que known_hosts ya tiene
	// para ese equipo; si no, el servidor puede ofrecer otro tipo y parecer
	// una huella cambiada.
	cfg.HostKeyAlgorithms = knownAlgorithms(hostKey, addr)
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		var ke *knownhosts.KeyError
		if errors.As(err, &ke) {
			if len(ke.Want) == 0 {
				return nil, fmt.Errorf("El equipo SSH %s no está en known_hosts. Conéctate una vez con «ssh %s@%s» y acepta su huella.", host, user, host)
			}
			return nil, fmt.Errorf("La huella del equipo SSH %s cambió. Por seguridad no me conecto; revisa known_hosts.", host)
		}
		return nil, fmt.Errorf("No pude entrar por SSH a %s: %v", addr, err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		client.Close()
		return nil, err
	}
	t := &tunnel{ln: ln, client: client, port: ln.Addr().(*net.TCPAddr).Port, dead: make(chan struct{})}
	go func() { client.Wait(); t.Close() }()
	go t.keepalive()
	go func() {
		for {
			local, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				type dialed struct {
					conn net.Conn
					err  error
				}
				ch := make(chan dialed, 1)
				go func() { c, err := client.Dial("tcp", target); ch <- dialed{c, err} }()
				var remote net.Conn
				select {
				case d := <-ch:
					if d.err != nil {
						local.Close()
						return
					}
					remote = d.conn
				case <-time.After(sshDialTimeout):
					// El servidor SSH ni contesta: el túnel ya no sirve.
					t.Close()
					local.Close()
					return
				}
				go func() { io.Copy(remote, local); remote.Close() }()
				io.Copy(local, remote)
				local.Close()
			}()
		}
	}()
	return t, nil
}

// knownAlgorithms pregunta a known_hosts con una llave de prueba: el error
// trae las llaves registradas para ese equipo, y de ahí salen sus tipos.
func knownAlgorithms(cb ssh.HostKeyCallback, addr string) []string {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil
	}
	probe, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil
	}
	tcp, _ := net.ResolveTCPAddr("tcp", addr)
	var remote net.Addr = tcp
	if tcp == nil {
		remote = &net.TCPAddr{}
	}
	var ke *knownhosts.KeyError
	if err := cb(addr, remote, probe.PublicKey()); !errors.As(err, &ke) {
		return nil
	}
	var algos []string
	seen := map[string]bool{}
	add := func(a string) {
		if !seen[a] {
			seen[a] = true
			algos = append(algos, a)
		}
	}
	for _, k := range ke.Want {
		switch t := k.Key.Type(); t {
		case ssh.KeyAlgoRSA:
			add(ssh.KeyAlgoRSASHA512)
			add(ssh.KeyAlgoRSASHA256)
			add(t)
		default:
			add(t)
		}
	}
	return algos
}

func sshAuth(keyPath string) ([]ssh.AuthMethod, error) {
	var methods []ssh.AuthMethod
	var signers []ssh.Signer
	paths := []string{keyPath}
	if keyPath == "" {
		for _, n := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
			paths = append(paths, filepath.Join(homeDir(), ".ssh", n))
		}
	}
	for _, p := range paths {
		if p == "" {
			continue
		}
		b, err := os.ReadFile(expandHome(p))
		if err != nil {
			if keyPath != "" && p == keyPath {
				return nil, fmt.Errorf("No pude leer la llave SSH %s: %v", p, err)
			}
			continue
		}
		signer, err := ssh.ParsePrivateKey(b)
		if err != nil {
			var pp *ssh.PassphraseMissingError
			if errors.As(err, &pp) {
				continue // con frase de paso: se usa por el agente SSH
			}
			if p == keyPath {
				return nil, fmt.Errorf("La llave SSH %s no es válida: %v", p, err)
			}
			continue
		}
		signers = append(signers, signer)
	}
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			methods = append(methods, ssh.PublicKeysCallback(agent.NewClient(conn).Signers))
		}
	}
	if len(signers) > 0 {
		methods = append([]ssh.AuthMethod{ssh.PublicKeys(signers...)}, methods...)
	}
	if len(methods) == 0 {
		return nil, errors.New("No encontré una llave SSH ni un agente SSH. Indica la ruta de tu llave privada.")
	}
	return methods, nil
}

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

func expandHome(p string) string {
	if p == "~" {
		return homeDir()
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(homeDir(), p[2:])
	}
	return p
}

// ── Llavero del sistema

type secretIn struct {
	ID       string `json:"id"`
	Password string `json:"password"`
}

func handleSecretSet(in secretIn) (any, error) {
	if in.ID == "" {
		return nil, errors.New("Falta el id de la conexión.")
	}
	if err := keyring.Set(keyringService, in.ID, in.Password); err != nil {
		return nil, fmt.Errorf("No pude guardar la contraseña en el llavero del sistema: %v", err)
	}
	return map[string]bool{"ok": true}, nil
}

func handleSecretDelete(in secretIn) (any, error) {
	_ = keyring.Delete(keyringService, in.ID)
	closeConn(in.ID)
	return map[string]bool{"ok": true}, nil
}

type closeIn struct {
	ID string `json:"id"`
}

func handleClose(in closeIn) (any, error) {
	closeConn(in.ID)
	return map[string]bool{"ok": true}, nil
}

// closeConn cierra todo lo abierto con ese id (tras editar o borrar la conexión).
// Las claves del pool son huellas, no ids: se cierra todo, que es barato y seguro.
func closeConn(string) {
	poolMu.Lock()
	defer poolMu.Unlock()
	for k, p := range pool {
		p.db.Close()
		p.tunnel.Close()
		delete(pool, k)
	}
}
