package backup

import (
	"encoding/base64"
	"net/http"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
)

// beanByID reads one bean of lib, failing the test when it is gone.
func beanByID(t *testing.T, lib library.Library, id int64) library.Entity {
	t.Helper()
	for _, bean := range lib.Beans {
		switch bid := bean["id"].(type) {
		case int64:
			if bid == id {
				return bean
			}
		case float64:
			if int64(bid) == id {
				return bean
			}
		}
	}
	t.Fatalf("bean %d missing from restored library: %v", id, lib.Beans)
	return nil
}

// TestStreamRoundTrip_KeepsBeanStickerFlag proves a zip export keeps both
// values of the bean sticker flag across a restore into a fresh install.
func TestStreamRoundTrip_KeepsBeanStickerFlag(t *testing.T) {
	srcDir := useImageDir(t)
	h1, deps1, _ := newTestHandlers(t)
	writeImageFile(t, srcDir, "1.png", fakePNG())
	writeImageFile(t, srcDir, "2.png", fakePNG())
	if err := deps1.LibRepo.SaveLibrary(library.Library{Beans: []library.Entity{
		{"id": int64(1), "name": "Sticker", "image": "png", "imageSticker": true},
		{"id": int64(2), "name": "Shop", "image": "png", "imageSticker": false},
	}}); err != nil {
		t.Fatalf("seeding library: %v", err)
	}

	rec := doJSON(t, newMux(h1), http.MethodPost, "/api/backup", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("export status = %d; body=%s", rec.Code, rec.Body.String())
	}
	zipBytes := append([]byte(nil), rec.Body.Bytes()...)

	targetDir := t.TempDir()
	useImageDirAt(t, targetDir)
	h2, deps2, _ := newTestHandlersInDir(t)
	if rr := doZip(t, newMux(h2), "/api/restore", zipBytes, nil); rr.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rr.Code, rr.Body.String())
	}

	lib, err := deps2.LibRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	bean1 := beanByID(t, lib, 1)
	if bean1["imageSticker"] != true {
		t.Errorf("sticker bean imageSticker = %v, want true", bean1["imageSticker"])
	}
	if bean1["image"] != "png" {
		t.Errorf("sticker bean image = %v, want png", bean1["image"])
	}
	bean2 := beanByID(t, lib, 2)
	if bean2["imageSticker"] != false {
		t.Errorf("shop bean imageSticker = %v, want false", bean2["imageSticker"])
	}
	if bean2["image"] != "png" {
		t.Errorf("shop bean image = %v, want png", bean2["image"])
	}
}

// TestRestore_OlderBackupDerivesStickerFlag restores a legacy JSON bundle
// written before the flag existed (no `imageSticker` anywhere) and checks the
// derived default, including a bean whose photo is missing from the bundle.
func TestRestore_OlderBackupDerivesStickerFlag(t *testing.T) {
	useImageDir(t)
	h, deps, _ := newTestHandlers(t)

	bundle := map[string]any{
		"glp_backup": true,
		"shots":      []any{},
		"coffee_library": map[string]any{
			"beans": []any{
				map[string]any{"id": int64(1), "name": "Old sticker", "image": "png"},
				map[string]any{"id": int64(2), "name": "Old photo", "image": "jpg"},
				map[string]any{"id": int64(3), "name": "Dropped", "image": "png", "imageSticker": true},
			},
		},
		"images": map[string]any{
			"1.png": base64.StdEncoding.EncodeToString(fakePNG()),
			"2.jpg": base64.StdEncoding.EncodeToString(tinyJPEG(t, 48, 36)),
		},
	}
	rec := doJSON(t, newMux(h), http.MethodPost, "/api/restore", mustMarshal(t, bundle))
	if rec.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body=%s", rec.Code, rec.Body.String())
	}

	lib, err := deps.LibRepo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if got := beanByID(t, lib, 1)["imageSticker"]; got != true {
		t.Errorf("older png bean imageSticker = %v, want true", got)
	}
	if got := beanByID(t, lib, 2)["imageSticker"]; got != false {
		t.Errorf("older jpg bean imageSticker = %v, want false", got)
	}
	dropped := beanByID(t, lib, 3)
	if _, ok := dropped["imageSticker"]; ok {
		t.Errorf("bean whose photo was dropped kept imageSticker = %v", dropped["imageSticker"])
	}
}
