package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// testSrcDir returns public-src/, whose path is resolved from this package's
// own directory (go/cmd/frontend-build) rather than from the module root: go
// test runs each package with the working directory set to that package, so
// run()'s `../public-src` default doesn't apply here.
func testSrcDir(t *testing.T) string {
	t.Helper()
	src := filepath.Join("..", "..", "..", "public-src")
	if _, err := os.Stat(filepath.Join(src, "main.js")); err != nil {
		t.Skipf("public-src not available: %v", err)
	}
	return src
}

func TestRunBundlesRelativeHashedAssets(t *testing.T) {
	out := t.TempDir()
	if err := run(testSrcDir(t), out); err != nil {
		t.Fatalf("run: %v", err)
	}

	html, err := os.ReadFile(filepath.Join(out, "index.html"))
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	page := string(html)

	// The source <script> tag must be gone, replaced by a hashed entry script.
	if strings.Contains(page, `src="./main.js"`) {
		t.Error("index.html still references the source entry point ./main.js")
	}
	if !regexp.MustCompile(`<script type="module" crossorigin src="\./assets/main-[A-Z0-9]+\.js">`).MatchString(page) {
		t.Errorf("index.html has no hashed relative entry script:\n%s", headOf(page))
	}

	// Every asset URL must stay relative (#797): an absolute "/assets/…"
	// breaks under HA Ingress's dynamic path prefix.
	for _, attr := range []string{"src", "href"} {
		if regexp.MustCompile(attr + `="/`).MatchString(page) {
			t.Errorf("index.html contains an absolute %s=\"/…\" URL", attr)
		}
	}

	// Each relative URL the build injected must actually exist in dist/.
	refs := regexp.MustCompile(`(?:src|href)="(\./[^"]+)"`).FindAllStringSubmatch(page, -1)
	if len(refs) < 2 {
		t.Fatalf("expected an entry script plus at least a stylesheet, got %d refs", len(refs))
	}
	for _, m := range refs {
		rel := filepath.FromSlash(strings.TrimPrefix(m[1], "./"))
		if _, err := os.Stat(filepath.Join(out, rel)); err != nil {
			t.Errorf("index.html references %s, which was not written: %v", m[1], err)
		}
	}

	// Vite's "public dir" convention is preserved: these ship unbundled.
	for _, name := range []string{"manifest.json", "sw.js", "icon.png", "countries-110m.json"} {
		if _, err := os.Stat(filepath.Join(out, name)); err != nil {
			t.Errorf("public/%s was not copied into the output: %v", name, err)
		}
	}

	// CSS extracted from main.js's own `import './style.css'`.
	if matches, _ := filepath.Glob(filepath.Join(out, "assets", "main-*.css")); len(matches) == 0 {
		t.Error("no hashed stylesheet in assets/")
	}
}

func TestRunRejectsMissingSources(t *testing.T) {
	err := run(t.TempDir(), t.TempDir())
	if err == nil {
		t.Fatal("expected an error for a source directory with no main.js")
	}
	if !strings.Contains(err.Error(), "main.js") {
		t.Errorf("error should name the missing entry point, got: %v", err)
	}
}

func TestRunRejectsIndexWithoutScriptTag(t *testing.T) {
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "main.js"), "console.log('x');\n")
	writeFile(t, filepath.Join(src, "index.html"), "<html><head></head><body></body></html>\n")

	err := run(src, t.TempDir())
	if err == nil {
		t.Fatal("expected an error for an index.html without the entry script tag")
	}
	if !strings.Contains(err.Error(), "script tag") {
		t.Errorf("error should mention the missing script tag, got: %v", err)
	}
}

func TestStaticImportClosureFollowsOnlyStaticImports(t *testing.T) {
	m := &metafile{Outputs: map[string]metaOutput{
		"entry.js": {Imports: []metaImport{
			{Path: "static.js", Kind: "import-statement"},
			{Path: "lazy-echarts.js", Kind: "dynamic-import"},
		}},
		"static.js": {Imports: []metaImport{
			{Path: "nested.js", Kind: "import-statement"},
			{Path: "entry.js", Kind: "import-statement"}, // cycle must terminate
		}},
	}}

	got := m.staticImportClosure("entry.js")
	want := []string{"static.js", "nested.js"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("staticImportClosure = %v, want %v (dynamic imports must stay off the preload path)", got, want)
	}
}

func TestRelFromOutDir(t *testing.T) {
	// Both a relative -out (esbuild reports CWD-relative metafile keys then)
	// and an absolute -out (absolute keys) must yield the same URL.
	got, err := relFromOutDir(filepath.Join("..", ".."), filepath.Join("..", "..", "assets", "main-ABC12345.js"))
	if err != nil {
		t.Fatalf("relFromOutDir(relative): %v", err)
	}
	if want := "./assets/main-ABC12345.js"; got != want {
		t.Errorf("relFromOutDir(relative) = %q, want %q", got, want)
	}

	out := t.TempDir()
	got, err = relFromOutDir(out, filepath.Join(out, "assets", "main-ABC12345.js"))
	if err != nil {
		t.Fatalf("relFromOutDir(absolute): %v", err)
	}
	if want := "./assets/main-ABC12345.js"; got != want {
		t.Errorf("relFromOutDir(absolute) = %q, want %q", got, want)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func headOf(page string) string {
	if len(page) > 400 {
		return page[:400]
	}
	return page
}
