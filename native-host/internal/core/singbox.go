// Package core manages the sing-box child process lifecycle.
package core

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Manager owns at most one running sing-box process.
type Manager struct {
	mu        sync.Mutex
	binPath   string
	workDir   string
	cmd       *exec.Cmd
	port      int
	startedAt time.Time

	// OnLog is called for each stdout/stderr line from sing-box.
	OnLog func(level, line string)
	// OnExit is called when the process exits (nil err = clean).
	OnExit func(err error)
}

// NewManager locates the sing-box binary next to the host executable
// (typically vendor-bin/) and prepares a work directory.
func NewManager() (*Manager, error) {
	exePath, err := os.Executable()
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(exePath)

	candidates := []string{
		filepath.Join(dir, singBoxName()),
		filepath.Join(dir, "vendor-bin", singBoxName()),
		filepath.Join(dir, "..", "vendor-bin", singBoxName()),
	}
	var bin string
	for _, c := range candidates {
		if _, statErr := os.Stat(c); statErr == nil {
			bin, _ = filepath.Abs(c)
			break
		}
	}
	if bin == "" {
		return nil, fmt.Errorf("sing-box binary not found near %s", dir)
	}

	workDir := filepath.Join(os.TempDir(), "magicproxy")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		return nil, err
	}
	return &Manager{binPath: bin, workDir: workDir}, nil
}

func singBoxName() string {
	if isWindows() {
		return "sing-box.exe"
	}
	return "sing-box"
}

// SingBoxPath returns the absolute path to the sing-box binary.
func (m *Manager) SingBoxPath() string { return m.binPath }

// FreePort asks the OS for an available TCP port on 127.0.0.1.
func FreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// ResolvePort keeps the inbound port stable across restarts: it reuses the
// requested port when it's free, and only falls back to a fresh free port if
// that one is taken. A stable port means chrome.proxy rarely needs re-pointing.
// The requested port is retried briefly because a just-killed sing-box may not
// have released its socket yet.
func ResolvePort(requested int) (int, error) {
	if requested > 0 {
		addr := fmt.Sprintf("127.0.0.1:%d", requested)
		for attempt := 0; attempt < 5; attempt++ {
			l, err := net.Listen("tcp", addr)
			if err == nil {
				l.Close()
				return requested, nil
			}
			time.Sleep(150 * time.Millisecond)
		}
	}
	return FreePort()
}

// Version returns the sing-box version string.
func (m *Manager) Version() string {
	cmd := exec.Command(m.binPath, "version")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	// First line looks like "sing-box version 1.9.0".
	line := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	fields := strings.Fields(line)
	if len(fields) >= 3 {
		return fields[2]
	}
	return line
}

// Check validates a config without running it (sing-box check).
func (m *Manager) Check(cfg []byte) error {
	path := filepath.Join(m.workDir, "check.json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		return err
	}
	cmd := exec.Command(m.binPath, "check", "-c", path)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("config invalid: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// Running reports whether a process is currently active.
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cmd != nil
}

// Status returns running state, port, and uptime seconds.
func (m *Manager) Status() (bool, int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == nil {
		return false, 0, 0
	}
	return true, m.port, int(time.Since(m.startedAt).Seconds())
}

// Start writes the config and launches sing-box. Any previously running
// instance is stopped first.
func (m *Manager) Start(cfg []byte, port int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.cmd != nil {
		m.stopLocked()
	}

	path := filepath.Join(m.workDir, "config.json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		return err
	}

	cmd := exec.Command(m.binPath, "run", "-c", path)
	cmd.Dir = m.workDir
	hideWindow(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start sing-box: %w", err)
	}

	m.cmd = cmd
	m.port = port
	m.startedAt = time.Now()

	go m.pump(stdout)
	go m.pump(stderr)

	started := cmd
	go func() {
		waitErr := started.Wait()
		m.mu.Lock()
		if m.cmd == started {
			m.cmd = nil
			m.port = 0
		}
		m.mu.Unlock()
		if m.OnExit != nil {
			m.OnExit(waitErr)
		}
	}()

	return nil
}

func (m *Manager) pump(r interface{ Read([]byte) (int, error) }) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := stripANSI(sc.Text())
		if m.OnLog != nil {
			m.OnLog(detectLevel(line), line)
		}
	}
}

// sing-box colourises its output even when stdout is a pipe rather than a
// terminal, so raw escape sequences would reach the popup's log viewer — the one
// place a user looks when the proxy will not connect — and render as garbage.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

func detectLevel(line string) string {
	l := strings.ToLower(line)
	switch {
	case strings.Contains(l, "error") || strings.Contains(l, "fatal"):
		return "error"
	case strings.Contains(l, "warn"):
		return "warn"
	default:
		return "info"
	}
}

// Stop terminates the running process, if any.
func (m *Manager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.stopLocked()
}

func (m *Manager) stopLocked() error {
	if m.cmd == nil || m.cmd.Process == nil {
		return nil
	}
	proc := m.cmd.Process
	m.cmd = nil
	m.port = 0
	// Kill is reliable cross-platform; sing-box has no cleanup that needs SIGTERM.
	if err := proc.Kill(); err != nil {
		return err
	}
	return nil
}
