//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
)

// watchParent: en Windows un huérfano no cambia de padre (os.Getppid sigue
// diciendo el mismo número), así que se abre el proceso padre y se espera a
// que termine. El motor no le deja la entrada estándar abierta al puente, así
// que su cierre no sirve de señal.
func watchParent(onGone func()) {
	const synchronize = 0x00100000
	h, err := syscall.OpenProcess(synchronize, false, uint32(os.Getppid()))
	if err != nil {
		// Sin permiso para abrirlo (o ya no existe): se revisa cada tanto si sigue vivo.
		for range time.Tick(2 * time.Second) {
			if p, err := syscall.OpenProcess(synchronize, false, uint32(os.Getppid())); err != nil {
				onGone()
			} else {
				syscall.CloseHandle(p)
			}
		}
		return
	}
	defer syscall.CloseHandle(h)
	_, _ = syscall.WaitForSingleObject(h, syscall.INFINITE)
	onGone()
}
