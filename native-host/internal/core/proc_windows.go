//go:build windows

package core

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

func isWindows() bool { return true }

// hideWindow prevents a console window from flashing when launching sing-box.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
)

const (
	// JobObjectExtendedLimitInformation, the information class accepted by
	// SetInformationJobObject for the struct below.
	jobObjectExtendedLimitClass = 9
	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when the last handle to the job closes,
	// every process still in the job is terminated.
	jobObjectLimitKillOnJobClose = 0x00002000
)

type ioCounters struct {
	ReadOperationCount  uint64
	WriteOperationCount uint64
	OtherOperationCount uint64
	ReadTransferCount   uint64
	WriteTransferCount  uint64
	OtherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation jobObjectBasicLimitInformation
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

// jobHandle is deliberately package-level and never closed: the job dies with the
// host process, which is precisely the lifetime we want to tie sing-box to.
var jobHandle syscall.Handle

// ConfineChildren binds this process — and therefore every process it spawns — to
// a job object marked KILL_ON_JOB_CLOSE.
//
// Without it a sing-box started by the host outlives it: when the host is killed
// (Chrome shutting down hard, a crash, Task Manager) nothing runs Stop(), so the
// core keeps running and keeps holding the inbound port. That orphan then answers
// the next session's traffic with the previous session's config, which is how we
// twice ended up debugging a proxy that ignored our changes.
//
// The host adds *itself* rather than each child: on Windows a process created by a
// process in a job joins that job automatically, so this covers `sing-box run`,
// the short-lived `check`/`version` invocations, and anything they might spawn —
// with no window between CreateProcess and the assignment for a child to escape
// through. Windows 8 and later allow nested jobs, so this still works when the
// browser has already placed the host in a job of its own.
func ConfineChildren() error {
	if jobHandle != 0 {
		return nil
	}

	h, _, callErr := procCreateJobObjectW.Call(0, 0) // unnamed, non-inheritable
	if h == 0 {
		return fmt.Errorf("CreateJobObject: %w", callErr)
	}
	handle := syscall.Handle(h)

	var info jobObjectExtendedLimitInformation
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	if r, _, callErr := procSetInformationJobObject.Call(
		h,
		jobObjectExtendedLimitClass,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	); r == 0 {
		syscall.CloseHandle(handle)
		return fmt.Errorf("SetInformationJobObject: %w", callErr)
	}

	self, err := syscall.GetCurrentProcess()
	if err != nil {
		syscall.CloseHandle(handle)
		return fmt.Errorf("GetCurrentProcess: %w", err)
	}
	if r, _, callErr := procAssignProcessToJobObject.Call(h, uintptr(self)); r == 0 {
		syscall.CloseHandle(handle)
		return fmt.Errorf("AssignProcessToJobObject: %w", callErr)
	}

	jobHandle = handle
	return nil
}
