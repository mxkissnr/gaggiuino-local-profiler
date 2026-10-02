package machines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

// This file holds the short-lived-connection-per-call JSON WebSocket client
// for GaggiMate machines: request() and waitForStatus(). Protocol shape: one
// WebSocket at ws://<host>/ws, JSON frames with a `tp` (type) field;
// requests are `req:<name>` (optionally carrying an `rid` for correlation),
// answered by a `res:<name>` frame; the server also pushes unsolicited
// `evt:status` frames on its own cadence.
//
// The GaggiMateLiveClient (a third, persistent-connection pattern) lives in
// gaggimate_live.go (#952): GaggiMateAdapter.GetStatus reads its cache and
// only falls back to gaggimateWaitForStatus below when the cache has no
// fresh frame yet.

const gaggimateWSTimeout = 8 * time.Second

func gaggimateWSURL(baseURL string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", fmt.Errorf("invalid base URL: %w", err)
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	return fmt.Sprintf("%s://%s/ws", scheme, u.Host), nil
}

// gaggimateRequest sends one `req:<name>` frame with a request id for
// correlation and resolves with the payload of the first matching
// `res:<name>` frame that echoes the same rid. GaggiMate firmware echoes
// rid back as a string even though it's sent as a number (#342,
// live-verified) — the comparison below is type-tolerant (string(rid)
// either way).
func gaggimateRequest(ctx context.Context, baseURL, reqType string, payload map[string]any) (map[string]any, error) {
	if len(reqType) < 4 || reqType[:4] != "req:" {
		return nil, fmt.Errorf("not a request type: %s", reqType)
	}
	resType := "res:" + reqType[4:]
	rid := rand.Intn(1_000_000_000)

	conn, ctx, cancel, err := wsConnect(ctx, baseURL, gaggimateWSURL, gaggimateWSTimeout)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer conn.CloseNow()

	frame := map[string]any{"tp": reqType, "rid": rid}
	for k, v := range payload {
		frame[k] = v
	}
	body, err := json.Marshal(frame)
	if err != nil {
		return nil, err
	}
	if err := conn.Write(ctx, websocket.MessageText, body); err != nil {
		return nil, fmt.Errorf("sending request: %w", err)
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, fmt.Errorf("timed out waiting for %q from the machine", resType)
			}
			return nil, fmt.Errorf("waiting for %q from the machine: %w", resType, err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg["tp"] != resType {
			continue
		}
		if msgRID, ok := msg["rid"]; ok && fmt.Sprint(msgRID) != fmt.Sprint(rid) {
			continue
		}
		conn.Close(websocket.StatusNormalClosure, "")
		return msg, nil
	}
}

// mergeGaggiMateStatus merges one evt:status frame onto a previous status map
// and returns a NEW map. Since firmware v1.9.0 frames are partial: a key that
// is absent keeps its previous value, a key sent as JSON null clears it. The
// previous map is never mutated because Status() hands the cached map to
// callers that read it after the session lock is released.
func mergeGaggiMateStatus(prev, frame map[string]any) map[string]any {
	merged := make(map[string]any, len(prev)+len(frame))
	for k, v := range prev {
		merged[k] = v
	}
	for k, v := range frame {
		if v == nil {
			delete(merged, k)
			continue
		}
		merged[k] = v
	}
	return merged
}

// gaggimateWaitForStatus connects and merges evt:status broadcasts
// (unsolicited telemetry, not a request/response) until at least one live
// reading (ct) has arrived, then resolves with the merged fields. On firmware
// <= v1.8.1 the first frame is already full, so it returns immediately as
// before; on v1.9.0 the first frame is a slow snapshot without ct, so it keeps
// merging until a fast frame fills the live keys in.
func gaggimateWaitForStatus(ctx context.Context, baseURL string, timeout time.Duration) (map[string]any, error) {
	conn, ctx, cancel, err := wsConnect(ctx, baseURL, gaggimateWSURL, timeout)
	if err != nil {
		return nil, err
	}
	defer cancel()
	defer conn.CloseNow()

	merged := map[string]any{}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, fmt.Errorf("timed out waiting for evt:status from the machine")
			}
			return nil, fmt.Errorf("waiting for evt:status from the machine: %w", err)
		}
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg["tp"] == "evt:status" {
			merged = mergeGaggiMateStatus(merged, msg)
			if _, ok := merged["ct"]; !ok {
				continue
			}
			conn.Close(websocket.StatusNormalClosure, "")
			return merged, nil
		}
	}
}
