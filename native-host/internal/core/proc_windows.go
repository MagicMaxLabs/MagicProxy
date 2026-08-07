//go:build windows

package core

import (
	"os/exec"
	"syscall"
)

func isWindows() bool { return true }

// hideWindow prevents a console window from flashing when launching sing-box.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
