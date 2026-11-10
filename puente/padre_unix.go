//go:build !windows

package main

import (
	"os"
	"time"
)

// watchParent: en Linux y macOS, cuando el padre muere el puente queda
// adoptado por otro proceso y su padre cambia.
func watchParent(onGone func()) {
	parent := os.Getppid()
	for range time.Tick(2 * time.Second) {
		if os.Getppid() != parent {
			onGone()
		}
	}
}
