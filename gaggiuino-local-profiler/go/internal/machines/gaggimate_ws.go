package machines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/coder/websocket"
)

// This file holds the short-lived-connection-per-call JSON WebSocket helper
// for GaggiMate machines: waitForStatus(). Protocol shape: one WebSocket at
// ws://<host>/ws, JSON frames with a `tp` (type) field; the server pushes
// unsolicited `evt:status` frames on its own cadence.
//
// The GaggiMateLiveClient (the persistent-connection pattern) lives in
// gaggimate_live.go (#952): GaggiMateAdapter.GetStatus reads its cache and
// only falls back to gaggimateWaitForStatus below when the cache has no
// fresh frame yet.

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

// maxGaggiMateStatusKeys bounds the merged status map so a device sending ever-new keys can't grow it without limit.
const maxGaggiMateStatusKeys = 128

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
		if _, exists := merged[k]; !exists && len(merged) >= maxGaggiMateStatusKeys {
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

	host := hostFromBaseURL(baseURL)

	merged := map[string]any{}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, fmt.Errorf("timed out waiting for evt:status from the machine")
			}
			return nil, fmt.Errorf("waiting for evt:status from the machine: %w", err)
		}
		countMachineWSMessage(host)
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
