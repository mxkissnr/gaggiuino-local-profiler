package library

import (
	"bytes"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// TestSetBeanImage_KeepsUserPhoto guards #1617: when the user uploaded their
// own photo while the import download was in flight, the download must not
// overwrite the file or switch the bean's image field. The download is made to
// succeed (fake allowlisted host + fake image client) and the bean already
// carries an image, so SetBeanImage must leave everything as it found it and
// fire no hook.
func TestSetBeanImage_KeepsUserPhoto(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	withFakeLookup(t, map[string][]net.IP{"kaffeebraun.com": {net.ParseIP("93.184.216.34")}})
	withFakeImageClient(t, "image/jpeg", makeJPEG(t, 64, 64))

	dir := t.TempDir()
	id := newID()
	userExt, ok := img.Save(dir, "", id, makeJPEG(t, 128, 128), "image/jpeg", img.ModeUpload)
	if !ok {
		t.Fatal("seeding the user's photo failed")
	}
	if err := repo.Update(func(l *Library) error {
		l.Beans = append(l.Beans, Entity{"id": id, "name": "Test Bean", "image": userExt})
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}

	userFile := filepath.Join(dir, img.Filename(id, userExt, ""))
	before, err := os.ReadFile(userFile)
	if err != nil {
		t.Fatalf("reading the user's photo: %v", err)
	}

	calls := 0
	orig := BeanImageHook
	BeanImageHook = func(int64) { calls++ }
	t.Cleanup(func() { BeanImageHook = orig })

	SetBeanImage(repo, dir, id, "https://kaffeebraun.com/bean.jpg")

	fresh, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if got, _ := fresh.Beans[0]["image"].(string); got != userExt {
		t.Errorf("bean image = %q, want the user's %q", got, userExt)
	}
	after, err := os.ReadFile(userFile)
	if err != nil {
		t.Fatalf("reading the user's photo after the import: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Error("the import overwrote the user's photo file")
	}
	if calls != 0 {
		t.Errorf("BeanImageHook fired %d times, want 0", calls)
	}
}
