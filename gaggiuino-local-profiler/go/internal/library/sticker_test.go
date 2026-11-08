package library

import (
	"net"
	"net/http"
	"strings"
	"testing"
)

// TestNormalizeBeanSticker pins the read-side rule (#1884): the flag is
// removed without a photo, and otherwise it is a bool that can only be true
// for a PNG — derived from the extension when the stored value is absent or
// not a bool.
func TestNormalizeBeanSticker(t *testing.T) {
	tests := []struct {
		name string
		in   Entity
		want any // nil means "the key must be absent"
	}{
		{"png without a flag", Entity{"image": "png"}, true},
		{"jpg without a flag", Entity{"image": "jpg"}, false},
		{"png explicitly not a sticker", Entity{"image": "png", "imageSticker": false}, false},
		{"png explicitly a sticker", Entity{"image": "png", "imageSticker": true}, true},
		{"jpg cannot be a sticker", Entity{"image": "jpg", "imageSticker": true}, false},
		{"non-bool value derives from the extension", Entity{"image": "png", "imageSticker": "yes"}, true},
		{"no photo drops the flag", Entity{"imageSticker": true}, nil},
		{"empty photo drops the flag", Entity{"image": "", "imageSticker": false}, nil},
		{"nil photo drops the flag", Entity{"image": nil, "imageSticker": true}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			normalizeBeanSticker(tt.in)
			got, ok := tt.in["imageSticker"]
			if tt.want == nil {
				if ok {
					t.Fatalf("imageSticker = %v, want the key absent", got)
				}
				return
			}
			if !ok {
				t.Fatalf("imageSticker absent, want %v", tt.want)
			}
			if got != tt.want {
				t.Fatalf("imageSticker = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestGetLibrary_DefaultsStickerFlagForOlderBeans covers libraries written
// before the flag existed: every PNG bean photo was a sticker cut-out then,
// so it keeps its look, and the first write persists the derived value.
func TestGetLibrary_DefaultsStickerFlagForOlderBeans(t *testing.T) {
	_, repo, sqlDB := newTestHandlers(t)
	if err := repo.SaveLibrary(Library{Beans: []Entity{
		{"id": int64(1), "image": "png"},
		{"id": int64(2), "image": "jpg"},
		{"id": int64(3), "name": "No photo"},
		nil,
	}}); err != nil {
		t.Fatalf("SaveLibrary: %v", err)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if len(lib.Beans) != 4 {
		t.Fatalf("beans = %d, want 4", len(lib.Beans))
	}
	if got := lib.Beans[0]["imageSticker"]; got != true {
		t.Errorf("png bean imageSticker = %v, want true", got)
	}
	if got := lib.Beans[1]["imageSticker"]; got != false {
		t.Errorf("jpg bean imageSticker = %v, want false", got)
	}
	if got, ok := lib.Beans[2]["imageSticker"]; ok {
		t.Errorf("photo-less bean imageSticker = %v, want the key absent", got)
	}

	if err := repo.Update(func(*Library) error { return nil }); err != nil {
		t.Fatalf("Update: %v", err)
	}
	var stored string
	if err := sqlDB.QueryRow(`SELECT data FROM library WHERE key = 'main'`).Scan(&stored); err != nil {
		t.Fatalf("reading stored library: %v", err)
	}
	if !strings.Contains(stored, `"imageSticker":true`) {
		t.Errorf("stored library does not persist the derived flag: %s", stored)
	}
}

// requireStickerFlag fails unless entity's imageSticker equals want.
func requireStickerFlag(t *testing.T, entity Entity, want bool) {
	t.Helper()
	got, ok := entity["imageSticker"]
	if !ok {
		t.Fatalf("imageSticker absent from %v", entity)
	}
	if got != want {
		t.Fatalf("imageSticker = %v, want %v", got, want)
	}
}

// TestPostBeanImage_StickerFlag covers the upload variants that set, keep and
// clear the flag, checking the HTTP response and the stored bean alike.
func TestPostBeanImage_StickerFlag(t *testing.T) {
	h, _, _ := newTestHandlers(t)
	mux := newMux(h)
	c := entityKindCases[0]
	id := createEntityVia(t, mux, c)
	base := c.createPath + "/" + itoa(id) + "/image"

	// A transparent PNG is stored as PNG, so ?sticker=1 marks it.
	rec := postImageRaw(t, mux, base+"?sticker=1", "image/png", makePNG(t, 64, 48))
	if rec.Code != http.StatusOK {
		t.Fatalf("sticker upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body := decodeBody(t, rec.Body.Bytes())
	if body["image"] != "png" {
		t.Errorf("response image = %v, want png", body["image"])
	}
	if body["imageSticker"] != true {
		t.Errorf("response imageSticker = %v, want true", body["imageSticker"])
	}
	requireStickerFlag(t, storedEntity(t, h, c, id), true)

	// Storing an original does not touch the main image, so the flag stays.
	rec = postImageRaw(t, mux, base+"?original=1&crop=0,0,0.5,0.5", "image/jpeg", makeJPEG(t, 200, 100))
	if rec.Code != http.StatusOK {
		t.Fatalf("store original status = %d; body=%s", rec.Code, rec.Body.String())
	}
	requireStickerFlag(t, decodeBody(t, rec.Body.Bytes()), true)
	requireStickerFlag(t, storedEntity(t, h, c, id), true)

	// A re-crop always writes a plain JPEG, so it clears the flag.
	rec = postImageRaw(t, mux, base+"?crop=0,0,1,1", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("re-crop status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body = decodeBody(t, rec.Body.Bytes())
	if body["image"] != "jpg" {
		t.Errorf("re-crop response image = %v, want jpg", body["image"])
	}
	if body["imageSticker"] != false {
		t.Errorf("re-crop response imageSticker = %v, want false", body["imageSticker"])
	}
	requireStickerFlag(t, storedEntity(t, h, c, id), false)

	// A plain new photo is not a sticker, even when the server keeps it as PNG.
	rec = postImageRaw(t, mux, base, "image/png", makePNG(t, 64, 48))
	if rec.Code != http.StatusOK {
		t.Fatalf("plain png upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body = decodeBody(t, rec.Body.Bytes())
	if body["image"] != "png" {
		t.Errorf("plain upload response image = %v, want png", body["image"])
	}
	if body["imageSticker"] != false {
		t.Errorf("plain upload response imageSticker = %v, want false", body["imageSticker"])
	}
	requireStickerFlag(t, storedEntity(t, h, c, id), false)

	// ?sticker=1 on an opaque image is stored as JPEG, so it is not a sticker.
	rec = postImageRaw(t, mux, base+"?sticker=1", "image/jpeg", makeJPEG(t, 64, 48))
	if rec.Code != http.StatusOK {
		t.Fatalf("opaque sticker upload status = %d; body=%s", rec.Code, rec.Body.String())
	}
	body = decodeBody(t, rec.Body.Bytes())
	if body["image"] != "jpg" {
		t.Errorf("opaque sticker upload response image = %v, want jpg", body["image"])
	}
	if body["imageSticker"] != false {
		t.Errorf("opaque sticker upload response imageSticker = %v, want false", body["imageSticker"])
	}
	requireStickerFlag(t, storedEntity(t, h, c, id), false)
}

// TestPostImage_StickerQueryRejected pins the rejections: sticker=1 only
// combines with nothing else, must be exactly "1", and is beans-only.
func TestPostImage_StickerQueryRejected(t *testing.T) {
	bean := entityKindCases[0]
	grinder := entityKindCases[1]
	tests := []struct {
		name    string
		c       entityKindCase
		query   string
		content string
		body    func(testing.TB) []byte
	}{
		{"sticker with crop", bean, "?sticker=1&crop=0,0,1,1", "image/png", func(tb testing.TB) []byte { return makePNG(tb, 32, 32) }},
		{"sticker with original and crop", bean, "?sticker=1&original=1&crop=0,0,1,1", "image/png", func(tb testing.TB) []byte { return makePNG(tb, 32, 32) }},
		{"sticker not 1", bean, "?sticker=0", "image/png", func(tb testing.TB) []byte { return makePNG(tb, 32, 32) }},
		{"repeated sticker", bean, "?sticker=1&sticker=1", "image/png", func(tb testing.TB) []byte { return makePNG(tb, 32, 32) }},
		{"sticker on a grinder", grinder, "?sticker=1", "image/png", func(tb testing.TB) []byte { return makePNG(tb, 32, 32) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h, _, _ := newTestHandlers(t)
			mux := newMux(h)
			id := createEntityVia(t, mux, tt.c)
			before := storedEntity(t, h, tt.c, id)

			rec := postImageRaw(t, mux, tt.c.createPath+"/"+itoa(id)+"/image"+tt.query, tt.content, tt.body(t))
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
			}
			after := storedEntity(t, h, tt.c, id)
			if _, ok := after["image"]; ok {
				t.Errorf("rejected request stored an image: %v", after)
			}
			if _, ok := after["imageSticker"]; ok {
				t.Errorf("rejected request stored a sticker flag: %v", after)
			}
			if len(after) != len(before) {
				t.Errorf("rejected request changed the entity: before=%v after=%v", before, after)
			}
		})
	}

	t.Run("grinder upload never carries the flag", func(t *testing.T) {
		h, _, _ := newTestHandlers(t)
		mux := newMux(h)
		id := createEntityVia(t, mux, grinder)
		uploadImageVia(t, mux, grinder, id)
		if _, ok := storedEntity(t, h, grinder, id)["imageSticker"]; ok {
			t.Fatalf("grinder got an imageSticker key: %v", storedEntity(t, h, grinder, id))
		}
	})
}

// TestSetBeanImage_TransparentShopPNGIsNotSticker covers the import path: a
// shop's product photo is never a sticker cut-out, even when the transparency
// makes the server keep it as PNG.
func TestSetBeanImage_TransparentShopPNGIsNotSticker(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	withFakeLookup(t, map[string][]net.IP{"kaffeebraun.com": {net.ParseIP("93.184.216.34")}})
	withFakeImageClient(t, "image/png", makePNG(t, 64, 64))

	id := newID()
	if err := repo.Update(func(lib *Library) error {
		lib.Beans = append(lib.Beans, Entity{"id": id, "name": "Imported"})
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}

	SetBeanImage(repo, t.TempDir(), id, "https://kaffeebraun.com/bean.png")

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	idx := findEntityIndex(lib.Beans, id)
	if idx == -1 {
		t.Fatalf("bean %d missing", id)
	}
	bean := lib.Beans[idx]
	if bean["image"] != "png" {
		t.Fatalf("image = %v, want png", bean["image"])
	}
	requireStickerFlag(t, bean, false)
}
