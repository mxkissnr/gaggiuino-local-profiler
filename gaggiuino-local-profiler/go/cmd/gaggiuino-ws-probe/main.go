// Command gaggiuino-ws-probe is the manual verification tool
// internal/machines/proto/doc.go promises: this package's protobuf
// decoder is cross-validated against lib/gaggiuino-proto.js's real
// runtime output (see proto/node_vectors_test.go), but never against a
// real machine — no network access to one was available while this
// package was built. This tool exists so that verification is a `go run`
// away once real hardware is reachable, in two modes:
//
//   - Live: `go run ./cmd/gaggiuino-ws-probe -host 192.168.1.50` opens
//     ws://192.168.1.50/ws, optionally sends one request (-action), and
//     prints every frame it receives — action name, raw hex, and (for
//     every action this package's proto types model) the decoded value as
//     JSON — until Ctrl+C or -timeout elapses. Compare the printed JSON
//     against what the machine's own web UI displays for the same state.
//   - Replay: `go run ./cmd/gaggiuino-ws-probe -hex <bytes>` decodes one
//     already-captured WebSocketMessageDto frame (e.g. saved from a
//     browser's DevTools WS inspector against the machine's own web UI)
//     without opening any connection — for verifying a specific recorded
//     frame offline.
//
// Not part of any test suite and not built/shipped by anything else in
// this repo — a standalone diagnostic, same spirit as a curl one-liner.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"time"

	"nhooyr.io/websocket"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
)

func main() {
	host := flag.String("host", "", "machine host or host:port, e.g. 192.168.1.50 (live mode)")
	action := flag.String("action", "", "optional request action to send once connected, e.g. g_prof_dict, g_sys_state (see internal/machines/ws.go's action* constants)")
	timeout := flag.Duration("timeout", 30*time.Second, "how long to listen for pushes before exiting (live mode)")
	hexFrame := flag.String("hex", "", "decode one hex-encoded WebSocketMessageDto frame and exit (replay mode) — no connection opened")
	flag.Parse()

	if *hexFrame != "" {
		replay(*hexFrame)
		return
	}
	if *host == "" {
		fmt.Fprintln(os.Stderr, "usage: gaggiuino-ws-probe -host <host> [-action <name>] [-timeout 30s]")
		fmt.Fprintln(os.Stderr, "       gaggiuino-ws-probe -hex <bytes>")
		os.Exit(2)
	}
	live(*host, *action, *timeout)
}

func replay(hexStr string) {
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		log.Fatalf("decoding -hex: %v", err)
	}
	printFrame(raw)
}

func live(host, action string, timeout time.Duration) {
	u := url.URL{Scheme: "ws", Host: host, Path: "/ws"}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ctx, timeoutCancel := context.WithTimeout(ctx, timeout)
	defer timeoutCancel()

	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		log.Fatalf("connecting to %s: %v", u.String(), err)
	}
	defer conn.CloseNow()
	fmt.Printf("connected to %s — listening for %s (Ctrl+C to stop early)\n", u.String(), timeout)

	if action != "" {
		req := &proto.WebSocketMessageDto{Action: action}
		if err := conn.Write(ctx, websocket.MessageBinary, req.Marshal()); err != nil {
			log.Fatalf("sending action %q: %v", action, err)
		}
		fmt.Printf("sent request action=%q\n", action)
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			fmt.Printf("connection ended: %v\n", err)
			return
		}
		printFrame(data)
	}
}

// printFrame decodes one WebSocketMessageDto envelope and, for every
// action this package's proto types model, its inner payload — printed as
// hex plus JSON, so the operator can eyeball field values against the
// machine's own web UI.
func printFrame(raw []byte) {
	var envelope proto.WebSocketMessageDto
	if err := envelope.Unmarshal(raw); err != nil {
		fmt.Printf("[%s] could not decode as WebSocketMessageDto: %v\n", hex.EncodeToString(raw), err)
		return
	}
	fmt.Printf("action=%q data_hex=%s\n", envelope.Action, hex.EncodeToString(envelope.Data))

	decoded, err := decodeByAction(envelope.Action, envelope.Data)
	if err != nil {
		fmt.Printf("  (no decoder for action %q, or decode failed: %v)\n", envelope.Action, err)
		return
	}
	pretty, _ := json.MarshalIndent(decoded, "  ", "  ")
	fmt.Printf("  %s\n", pretty)
}

// decodeByAction maps a push/response action name to the proto message
// type that decodes it — mirrors internal/machines/ws.go's/live.go's own
// action-to-type dispatch (see responseAction, pushSensor/pushSysState,
// respAck/respNotif).
func decodeByAction(action string, data []byte) (any, error) {
	var target interface{ Unmarshal([]byte) error }
	switch action {
	case "d_prof_dict":
		target = &proto.SavedProfilesDto{}
	case "d_prof":
		target = &proto.ProfileDto{}
	case "d_resp":
		target = &proto.WebSocketResponseDto{}
	case "d_notif":
		target = &proto.NotificationDto{}
	case "d_sensor_snap":
		target = &proto.SensorStateSnapshotDto{}
	case "d_sys_state":
		target = &proto.SystemStateDto{}
	default:
		return nil, fmt.Errorf("unrecognized action")
	}
	if err := target.Unmarshal(data); err != nil {
		return nil, err
	}
	return target, nil
}
