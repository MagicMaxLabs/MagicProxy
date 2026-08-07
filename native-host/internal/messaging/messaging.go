// Package messaging implements Chrome Native Messaging framing:
// each message is a little-endian uint32 length prefix followed by UTF-8 JSON.
package messaging

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Chrome limits a single host->extension message to 1 MB.
const maxMessageSize = 1024 * 1024

// Request from the extension.
type Request struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// Response to a request (correlated by ID).
type Response struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Event is an unsolicited push (logs, state changes).
type Event struct {
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

// Conn wraps stdin/stdout with framing. Writes are serialized so response and
// event goroutines never interleave a frame.
type Conn struct {
	r     io.Reader
	w     io.Writer
	wLock sync.Mutex
}

func NewConn(r io.Reader, w io.Writer) *Conn {
	return &Conn{r: r, w: w}
}

// Read blocks for the next framed message. Returns io.EOF when the port closes.
func (c *Conn) Read() (*Request, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(c.r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n == 0 || n > maxMessageSize*64 {
		return nil, fmt.Errorf("invalid frame length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.r, buf); err != nil {
		return nil, err
	}
	var req Request
	if err := json.Unmarshal(buf, &req); err != nil {
		return nil, fmt.Errorf("bad request json: %w", err)
	}
	return &req, nil
}

func (c *Conn) writeFrame(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > maxMessageSize {
		return fmt.Errorf("message too large: %d bytes", len(data))
	}
	c.wLock.Lock()
	defer c.wLock.Unlock()
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(data)))
	if _, err := c.w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = c.w.Write(data)
	return err
}

func (c *Conn) Respond(id string, result any) error {
	return c.writeFrame(Response{ID: id, OK: true, Result: result})
}

func (c *Conn) RespondError(id string, err error) error {
	return c.writeFrame(Response{ID: id, OK: false, Error: err.Error()})
}

func (c *Conn) Emit(event string, payload any) error {
	return c.writeFrame(Event{Event: event, Payload: payload})
}
