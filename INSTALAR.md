# Instalar Estudio SQL (guía para Claude)

Esta guía es para **Claude Code**: la persona te pidió instalar este mod en su equipo. Síguela en orden, en su idioma, y dile en una frase qué vas a hacer antes de cada paso que cambie algo. Funciona en **Windows 10/11** y **Linux**. En macOS los binarios están incluidos, pero nadie los ha probado.

Al terminar, el mod queda activo en **todas** las sesiones de Claude Code de la persona, en cualquier carpeta: `/sql` abre el panel y tú tienes la herramienta `consultar` para hacer consultas de solo lectura a la vista.

## 0. Antes de empezar

- Confirma con la persona que quiere instalarlo para todas sus sesiones (alcance `user`), porque cambia su configuración de Claude Code.
- Usa la herramienta de terminal que tengas: Bash o PowerShell. Abajo están los comandos de las dos.
- No la mandes a otra terminal: todos los comandos de esta guía los puedes ejecutar tú. Solo `/reload-plugins` y la contraseña de su base los tiene que escribir ella.
- **No le pidas contraseñas por el chat.** Las escribe ella en el formulario del panel, que las guarda en el llavero del sistema.

## 1. Versión de Claude Code

```
claude --version
```

Se necesita **2.1.303 o más reciente**, porque los mods con paneles son recientes. Si es más vieja, `claude update` y pídele a la persona que reinicie Claude Code antes de seguir.

## 2. Descargar el mod a una carpeta propia

El mod se instala **desde una carpeta clonada**, no directo desde GitHub: así lo puedes adaptar después, y cada cambio llega con `/reload-plugins`. Usa una carpeta fuera de OneDrive, porque la sincronización puede bloquear los archivos.

PowerShell (Windows):

```powershell
$destino = "$env:USERPROFILE\claude-mods\claude-code-estudio-sql"
if (Test-Path $destino) { git -C $destino pull } else { git clone https://github.com/waldooCreator/claude-code-estudio-sql $destino }
```

Bash (Linux, o Git Bash en Windows):

```bash
destino="$HOME/claude-mods/claude-code-estudio-sql"
[ -d "$destino" ] && git -C "$destino" pull || git clone https://github.com/waldooCreator/claude-code-estudio-sql "$destino"
```

Si la persona ya tiene la carpeta del mod, porque la copió o descomprimió un `.zip`, no clones: muévela a esa misma ubicación, o usa la ruta donde está si no está dentro de OneDrive.

En el resto de la guía, `<carpeta>` es esa ruta completa.

## 3. Comprobar que el puente arranca en este equipo

El mod habla con las bases de datos a través de un programa propio, el **puente**, que ya viene compilado en `bin/`. No hay que instalar Go, Node, ODBC ni drivers. Pruébalo: debe imprimir **una línea JSON** y quedarse esperando (deténlo con Ctrl+C, o deja que el tiempo de espera lo corte).

PowerShell (Windows; en Windows siempre escucha en `127.0.0.1` con un token):

```powershell
$p = Start-Process -FilePath "<carpeta>\bin\puente-windows-amd64.exe" -NoNewWindow -PassThru -RedirectStandardOutput "$env:TEMP\puente.txt"; Start-Sleep 2; Get-Content "$env:TEMP\puente.txt"; Stop-Process $p.Id
```

Debe mostrar algo como `{"token":"…","url":"http://127.0.0.1:50123"}`.

Bash (Linux x64; en ARM usa `puente-linux-arm64`):

```bash
timeout 2 "<carpeta>/bin/puente-linux-amd64"; echo
```

Debe mostrar `{"socket":"/tmp/estudio-sql-…/puente.sock"}`.

| Síntoma | Qué hacer |
| --- | --- |
| Windows: «Acceso denegado», el `.exe` desapareció o Defender avisa de una amenaza | El programa no está firmado y a veces Defender lo bloquea por error. Explícaselo a la persona. Ella decide si lo permite en Seguridad de Windows → Protección contra virus → Historial de protección → Permitir, o si agrega `<carpeta>\bin` a las exclusiones. No lo hagas tú. |
| Windows: aviso de SmartScreen | Que la persona elija «Más información» → «Ejecutar de todas formas» una vez. |
| Windows: el firewall pregunta si permitir el acceso | El puente solo escucha en `127.0.0.1` (este equipo). Puede elegir «Cancelar» o «Permitir»: funciona igual. |
| Linux: `Permission denied` | `chmod +x "<carpeta>"/bin/puente-*` |
| Linux: `cannot execute binary file` | Usaste el binario de otra arquitectura: revisa `uname -m`. |

Dependencias opcionales (no instales nada sin que la persona lo apruebe):

| Qué | Para qué | Si falta |
| --- | --- | --- |
| Llavero del sistema: Administrador de credenciales (Windows, ya viene), GNOME Keyring o KWallet (Linux) | Guardar las contraseñas de las conexiones | En Linux sin escritorio, por SSH o en WSL no suele haberlo: el panel avisa al guardar y las conexiones con contraseña no funcionan. Solución: `gnome-keyring` (pídele permiso para instalarlo). SQLite no lo necesita. |
| `wl-clipboard` (Wayland) o `xclip` / `xsel` (X11), solo Linux | Copiar celdas y resultados al portapapeles | Se copia por la terminal (OSC 52), que no todas permiten. En Windows se usa PowerShell, que ya viene. |
| Cliente OpenSSH y `~/.ssh/known_hosts` | Solo para conexiones con túnel SSH | Conéctate una vez con `ssh usuario@equipo` para registrar su huella. En Windows el agente es el servicio «OpenSSH Authentication Agent». |

## 4. Validar el mod

```
claude plugin validate "<carpeta>"
claude plugin test "<carpeta>"
```

Las dos deben terminar sin errores (`✔ Validation passed` y `0 fail`).

## 5. Instalarlo para todas las sesiones

```
claude plugin marketplace add "<carpeta>"
claude plugin install estudio-sql@estudio-sql --scope user
claude plugin list
```

En la lista debe aparecer `estudio-sql@estudio-sql` con `Scope: user`, `Status: enabled` y `Read from: <carpeta>`.

Si ya estaba instalado desde GitHub (sin carpeta), primero `claude plugin uninstall estudio-sql@estudio-sql` y luego repite este paso. Sus conexiones guardadas no se pierden.

## 6. Activarlo y comprobarlo

1. Pídele a la persona que escriba `/reload-plugins` en esta sesión, o que abra una sesión nueva. Las sesiones nuevas lo cargan solas.
2. Después, llama tú a la herramienta `mcp__estudio-sql__diagnostico`, o pídele que escriba `/sql-diagnostico`. Deben salir con ✔ el puente, el transporte y el llavero. El portapapeles en ✘ en Linux no impide usarlo (ver la tabla del paso 3).
3. Pídele que escriba `/sql` con la terminal ancha (**110 columnas o más**, o en pantalla completa). El panel se abre al lado de la conversación.
4. Ayúdala a crear su primera conexión (abajo) y, cuando la guarde, prueba tú `mcp__estudio-sql__consultar` con esa conexión y una consulta inocua (`SELECT 1`). La pestaña debe aparecer en el panel con el resultado.

Cuéntale a la persona en 3 o 4 frases qué quedó: `/sql` abre y cierra el panel; sus conexiones quedan guardadas y las contraseñas en el llavero; Ctrl+E ejecuta; y tú puedes consultar sus bases a la vista y siempre en solo lectura.

### La primera conexión

En el panel: **+ Nueva conexión** → elige el motor → llena los campos → **Probar conexión** → **Guardar**. Tab pasa al campo siguiente. Lo que va en cada motor:

| Motor | Servidor | Puerto | Usuario y contraseña | Base |
| --- | --- | --- | --- | --- |
| **SQL Server** | IP o nombre (`192.168.1.20`, `db.empresa.local`). Instancia con nombre: `EQUIPO\SQLEXPRESS` (o `.\SQLEXPRESS` en el mismo equipo). | `1433`. Con instancia con nombre se ignora el 1433 y el puerto lo dice el servicio SQL Server Browser; si la instancia tiene un puerto fijo, escríbelo. | Un usuario de SQL Server (`sa`, `lector`…), o `DOMINIO\usuario` con su contraseña. **En Windows, deja Usuario vacío para entrar con tu sesión de Windows** (autenticación integrada). | Opcional (si se deja vacía, la predeterminada del usuario). |
| **PostgreSQL** | IP o nombre | `5432` | El rol de PostgreSQL | Opcional (`postgres`). |
| **MySQL / MariaDB** | IP o nombre | `3306` | El usuario de MySQL | Opcional. |
| **SQLite** | El archivo: `/home/ana/datos/tienda.db` o `C:\Users\Ana\datos\tienda.db` (acepta `~`) | — | — | — |

Sugiérele marcar **Solo lectura** en conexiones de producción, y elegir un color para reconocerla en la barra de estado. Con **Conectar a través de un túnel SSH** se llena además el equipo intermedio (`usuario@equipo`) y, si hace falta, la llave (`~/.ssh/id_ed25519`).

Si **Probar conexión** falla, el mensaje dice qué revisar. Los más comunes:

- *El servidor rechazó la conexión / no respondió a tiempo:* dirección, puerto, VPN o firewall. En SQL Server, que TCP/IP esté habilitado en el SQL Server Configuration Manager.
- *No encontré esa instancia:* el servicio «SQL Server Browser» apagado o el UDP 1434 bloqueado; o escribe el puerto fijo de la instancia.
- *Falta el usuario:* dejar Usuario vacío solo funciona con Claude Code en Windows.
- *La conexión se guardó, pero la contraseña no:* no hay llavero del sistema (paso 3).

## 7. Si algo falla en este equipo

Corrige en `<carpeta>`, valida con el paso 4 y pide `/reload-plugins`. Dónde está cada cosa: `hooks/register.tsx` arranca el puente, el portapapeles y la herramienta; `hooks/estudio.tsx` es el panel; `puente/` es el puente en Go (recompilarlo está en el README). Problemas conocidos:

- **El panel no aparece:** la terminal es angosta. Necesita unas 110 columnas: pantalla completa o letra más pequeña.
- **«El puente no arranca» en Windows:** casi siempre es el antivirus (tabla del paso 3).
- **Proxy corporativo:** en Windows el mod le habla al puente por `http://127.0.0.1`. Si hay un proxy configurado para todo, `127.0.0.1` debe estar en sus excepciones (`NO_PROXY`).
- **Las tildes salen dañadas al copiar en Windows:** el mod copia con PowerShell en UTF-8; si se cambió a `clip.exe`, vuélvelo a PowerShell.
- **Dónde quedan los datos:** las conexiones (sin contraseñas) en el almacén de mods de Claude Code, `~/.claude/plugins/store/estudio-sql_…json` (en Windows `%USERPROFILE%\.claude\plugins\store\…`); las contraseñas, en el llavero del sistema con el servicio `estudio-sql`.

## Actualizar o quitar

- Actualizar: `git -C "<carpeta>" pull` y luego `/reload-plugins`. Si adaptaste algo, revisa primero `git -C "<carpeta>" status` para no pisarlo.
- Quitar: `claude plugin uninstall estudio-sql@estudio-sql` y `claude plugin marketplace remove estudio-sql`. La carpeta se puede borrar después. Las contraseñas quedan en el llavero con el nombre `estudio-sql` hasta que se borren desde el panel (borrar la conexión) o desde el llavero.
