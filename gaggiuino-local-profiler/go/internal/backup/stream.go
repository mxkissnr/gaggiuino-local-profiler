package backup

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// writeBundleJSON emits the exact same top-level JSON object routes/
// backup.js's gatherBackupData + json.Marshal produce, but incrementally:
// the scalar fields and the small sections (pre-gathered in `small`, see
// gatherSmallSections) are marshalled one at a time, the shots array
// streams one hydrated shot at a time from shots.Repository.
// ForEachShotForBackup, and — only for the legacy GET /api/backup path —
// the images map streams each file base64-encoded straight to w. Peak
// retention is one shot + the annotations accumulator (bounded by
// annotated-shot count, not datapoints size), never the whole shots table.
//
// small is gathered before the caller writes any response header, so a DB
// error there still becomes a clean 500; an error raised mid-stream here
// (a failed shot query after the array has started) cannot — the caller
// logs it and drops the connection, the same constraint Node's
// res.download has.
//
// sec == nil means a full export (every key present). A scoped export
// reproduces gatherBackupData's sectionBundleKeys selection exactly: an
// out-of-scope key is absent, not empty.
func (d Dependencies) writeBundleJSON(w io.Writer, small map[string]any, sec sections, inlineImages bool) error {
	bw := bufio.NewWriterSize(w, 32*1024)

	shotsInScope := sec == nil || sec.has("shots")
	imagesRequested := shotsInScope
	inScope := func(key string) bool {
		if sec == nil {
			return true
		}
		for section := range sec {
			for _, k := range sectionBundleKeys[section] {
				if k == key {
					return true
				}
			}
		}
		return false
	}

	first := true
	put := func(key string, v any) error {
		vb, err := json.Marshal(v)
		if err != nil {
			return err
		}
		if !first {
			bw.WriteByte(',')
		}
		first = false
		kb, _ := json.Marshal(key)
		bw.Write(kb)
		bw.WriteByte(':')
		bw.Write(vb)
		return nil
	}
	openKey := func(key string) {
		if !first {
			bw.WriteByte(',')
		}
		first = false
		kb, _ := json.Marshal(key)
		bw.Write(kb)
		bw.WriteByte(':')
	}

	bw.WriteByte('{')
	if err := put("glp_backup", true); err != nil {
		return err
	}
	if err := put("version", glpVersion); err != nil {
		return err
	}
	if err := put("created", bundleCreated()); err != nil {
		return err
	}
	if sec != nil {
		if err := put("sections", sec.orderedNames()); err != nil {
			return err
		}
	}

	// shots (streamed) + the annotations map accumulated during the stream.
	if shotsInScope {
		annotations := map[string]any{}
		openKey("shots")
		bw.WriteByte('[')
		firstShot := true
		err := d.ShotsRepo.ForEachShotForBackup(0, func(s shots.Shot) error {
			if ann, ok := s["annotation"].(map[string]any); ok && len(ann) > 0 {
				annotations[fmt.Sprintf("%v", s["id"])] = ann
			}
			stripped := make(map[string]any, len(s))
			for k, v := range s {
				if k == "annotation" || k == "score" {
					continue
				}
				stripped[k] = v
			}
			b, err := json.Marshal(stripped)
			if err != nil {
				return err
			}
			if !firstShot {
				bw.WriteByte(',')
			}
			firstShot = false
			bw.Write(b)
			return nil
		})
		if err != nil {
			return err
		}
		bw.WriteByte(']')
		if err := put("annotations", annotations); err != nil {
			return err
		}
	}

	for _, key := range []string{
		"coffee_library", "blocklist", "trash", "maintenance",
		"maintenance_log", "orders", "machines", "kv", "secrets",
	} {
		if !inScope(key) {
			continue
		}
		v, ok := small[key]
		if !ok {
			continue
		}
		if err := put(key, v); err != nil {
			return err
		}
	}

	if inlineImages && imagesRequested {
		openKey("images")
		bw.WriteByte('{')
		firstImg := true
		if entries, err := os.ReadDir(imageDir); err == nil {
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				f, err := os.Open(filepath.Join(imageDir, entry.Name()))
				if err != nil {
					continue // best-effort — one unreadable file must not fail the export
				}
				if !firstImg {
					bw.WriteByte(',')
				}
				firstImg = false
				kb, _ := json.Marshal(entry.Name())
				bw.Write(kb)
				bw.WriteByte(':')
				bw.WriteByte('"')
				enc := base64.NewEncoder(base64.StdEncoding, bw)
				_, copyErr := io.Copy(enc, f)
				enc.Close()
				f.Close()
				bw.WriteByte('"')
				if copyErr != nil {
					return copyErr
				}
			}
		}
		bw.WriteByte('}')
	}

	bw.WriteByte('}')
	return bw.Flush()
}
