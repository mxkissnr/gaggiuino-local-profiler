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
	if err := run(testSrcDir(t), out, ""); err != nil {
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
	err := run(t.TempDir(), t.TempDir(), "")
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

	// The source check runs before the node_modules one, so this stays
	// deterministic whether or not the checkout has `npm ci`'d.
	err := run(src, t.TempDir(), "")
	if err == nil {
		t.Fatal("expected an error for an index.html without the entry script tag")
	}
	if !strings.Contains(err.Error(), "script tag") {
		t.Errorf("error should mention the missing script tag, got: %v", err)
	}
}

// TestRunRejectsMissingNodeModules pins the failure mode behind #1033's first
// CI round: with no dependency tree installed, esbuild reported "Could not
// resolve echarts/chart.js/auto/topojson-client" once per import site and
// said nothing about the actual cause. Losing that tree must fail up front,
// with the fix in the message.
func TestRunRejectsMissingNodeModules(t *testing.T) {
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "main.js"), "console.log('x');\n")
	writeFile(t, filepath.Join(src, "index.html"),
		"<html><head>"+origScriptTag+"</head><body></body></html>\n")

	err := run(src, t.TempDir(), filepath.Join(t.TempDir(), "node_modules"))
	if err == nil {
		t.Fatal("expected an error for a missing node_modules tree")
	}
	for _, want := range []string{"node_modules not found", "npm ci"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q to be actionable, got: %v", want, err)
		}
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
	// Metafile keys are relative to AbsWorkingDir (base, the frontend root) —
	// not to the process working directory and not to outDir. Both the
	// base-relative keys esbuild writes for outputs inside the root and the
	// absolute ones it writes for outputs outside it must yield the same URL.
	base := t.TempDir()
	out := filepath.Join(base, "go", "internal", "webapp", "dist")
	key := filepath.Join("go", "internal", "webapp", "dist", "assets", "main-ABC12345.js")

	got, err := relFromOutDir(base, out, key)
	if err != nil {
		t.Fatalf("relFromOutDir(base-relative): %v", err)
	}
	if want := "./assets/main-ABC12345.js"; got != want {
		t.Errorf("relFromOutDir(base-relative) = %q, want %q", got, want)
	}

	got, err = relFromOutDir(base, out, filepath.Join(out, "assets", "main-ABC12345.js"))
	if err != nil {
		t.Fatalf("relFromOutDir(absolute): %v", err)
	}
	if want := "./assets/main-ABC12345.js"; got != want {
		t.Errorf("relFromOutDir(absolute) = %q, want %q", got, want)
	}
}

func TestEntryOutputMatchesNormalizedEntryPoints(t *testing.T) {
	base := t.TempDir()
	m := &metafile{Outputs: map[string]metaOutput{
		"public-src/main.js": {EntryPoint: "public-src/main.js", CSSBundle: "assets/main-ABC.css"},
		"assets/main-ABC.js": {Imports: []metaImport{{Path: "public-src/main.js", Kind: "import-statement"}}},
	}}

	// esbuild echoes the entry point back relative to AbsWorkingDir; callers
	// can hand in an absolute path, a base-relative one, or the "./"-prefixed
	// shape that normalization has to absorb.
	for _, entry := range []string{
		filepath.Join(base, "public-src", "main.js"),
		filepath.Join("public-src", "main.js"),
		"./public-src/main.js",
	} {
		p, out, ok := m.entryOutput(base, entry)
		if !ok {
			t.Errorf("entryOutput(%q) found no output, want the public-src/main.js entry", entry)
			continue
		}
		if p != "public-src/main.js" || out.CSSBundle != "assets/main-ABC.css" {
			t.Errorf("entryOutput(%q) = (%q, cssBundle %q), want the entry output with its CSS bundle", entry, p, out.CSSBundle)
		}
	}

	if _, _, ok := m.entryOutput(base, filepath.Join("public-src", "other.js")); ok {
		t.Error("entryOutput matched an output for a different entry point")
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
