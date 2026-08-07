//go:build !windows

package core

import "os/exec"

func isWindows() bool { return false }

// hideWindow is a no-op on non-Windows platforms.
func hideWindow(cmd *exec.Cmd) {}

// ConfineChildren is a no-op outside Windows: there is no job object to join, and
// the host's only supported target is Windows anyway.
func ConfineChildren() error { return nil }
