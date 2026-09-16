// Command frontend-build bundles the public-src/ SPA with esbuild's Go API
// and writes the result to internal/webapp/dist/ (or -out), replacing the
// npm/Vite build formerly run in the Dockerfile's Node stage and invoked by
// go/Makefile's `frontend` target (#1033). It reproduces the parts of
// vite.config.js that matter for internal/webapp's //go:embed all:dist and
// for running behind HA Ingress's dynamic path prefix (#797):
//   - relative asset URLs (no leading `/`, no absolute PublicPath)
//   - hashed, content-addressed output filenames
//   - code-splitting on the app's three dynamic import() boundaries
//     (echarts+topojson-client in analytics.js/flavor-wheel.js, qrcode in
//     library.js) so their ~1.1MB/7KB/24KB stay off the first-load path
//   - public-src/index.html's single module <script> tag replaced with the
//     hashed entry script, its modulepreload-able static-import chunks, and
//     its bundled stylesheet — the same shape Vite's HTML plugin produces,
//     hand-rolled here since esbuild has no HTML entry point support (see
//     the issue's "bit that needs hand-work")
//
// Unlike Vite's manualChunks, this relies on esbuild's automatic
// shared-chunk splitting rather than naming vendor chunks by hand — the
// three dynamic import() boundaries above are enough for esbuild to keep
// echarts/topojson/qrcode out of the entry chunk on their own. chart.js
// stays a static import (as before) and is inlined into the entry chunk
// instead of Vite's separate vendor-chartjs chunk; total first-load bytes
// are unaffected, just in one request instead of two.
//
// Vite stays a local-dev dependency (`npm run dev`, HMR) — esbuild's watch
// mode has no HMR, and this command is only the production image/CI path.
// See CONTRIBUTING.md's "Frontend build" section.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/evanw/esbuild/pkg/api"
)

func main() {
	srcDir := flag.String("src", "../public-src", "frontend source directory (Vite's former root)")
	outDir := flag.String("out", "internal/webapp/dist", "build output directory")
	flag.Parse()

	if err := run(*srcDir, *outDir); err != nil {
		log.Fatalf("frontend-build: %v", err)
	}
}

func run(srcDir, outDir string) error {
	entry := filepath.Join(srcDir, "main.js")
	indexHTML := filepath.Join(srcDir, "index.html")
	for _, required := range []string{entry, indexHTML} {
		if _, err := os.Stat(required); err != nil {
			return fmt.Errorf("required source file: %w", err)
		}
	}

	// The output dir is used as an absolute path: esbuild writes metafile
	// keys relative to the *working directory* (absolute for outputs
	// outside it, e.g. a -out under /tmp), so relFromOutDir has to anchor
	// both sides the same way to keep producing the "./…" URLs that
	// index.html must carry.
	outAbs, err := filepath.Abs(outDir)
	if err != nil {
		return fmt.Errorf("resolve output dir: %w", err)
	}
	if err := os.RemoveAll(outAbs); err != nil {
		return fmt.Errorf("clean output dir: %w", err)
	}
	assetsDir := filepath.Join(outAbs, "assets")
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return err
	}

	result := api.Build(api.BuildOptions{
		EntryPoints: []string{entry},
		Bundle:      true,
		Splitting:   true,
		Platform:    api.PlatformBrowser,
		Format:      api.FormatESModule,
		Outdir:      assetsDir,
		Metafile:    true,
		Write:       true,
		EntryNames:  "[name]-[hash]",
		ChunkNames:  "[name]-[hash]",
		AssetNames:  "[name]-[hash]",
		// Vite 8's implicit build target ("baseline-widely-available":
		// chrome111/edge111/firefox114/safari16.4/ios16.4, see Vite's own
		// ESBUILD_BASELINE_WIDELY_AVAILABLE_TARGET). Carried over because
		// esbuild emits no CSS vendor prefixes at all without a target —
		// the JS bundle is byte-identical to an untargeted (esnext) build
		// for this codebase, so this is purely about not silently losing
		// the CSS prefixes the Vite build produced.
		Engines: []api.Engine{
			{Name: api.EngineChrome, Version: "111"},
			{Name: api.EngineEdge, Version: "111"},
			{Name: api.EngineFirefox, Version: "114"},
			{Name: api.EngineSafari, Version: "16.4"},
			{Name: api.EngineIOS, Version: "16.4"},
		},
		MinifyWhitespace:  true,
		MinifyIdentifiers: true,
		MinifySyntax:      true,
		// style.css's three @font-face url()s are the only imported non-JS
		// assets; everything else the SPA pulls in is either a fetch()
		// against a path copied by copyPublicDir or an inline data: URI
		// esbuild handles without a loader entry.
		Loader: map[string]api.Loader{
			".woff2": api.LoaderFile,
		},
	})
	if len(result.Errors) > 0 {
		msgs := api.FormatMessages(result.Errors, api.FormatMessagesOptions{Color: false})
		return fmt.Errorf("esbuild build failed:\n%s", strings.Join(msgs, "\n"))
	}
	for _, w := range api.FormatMessages(result.Warnings, api.FormatMessagesOptions{Color: false}) {
		log.Printf("esbuild warning: %s", w)
	}

	meta, err := parseMetafile(result.Metafile)
	if err != nil {
		return fmt.Errorf("parse metafile: %w", err)
	}

	if err := copyPublicDir(filepath.Join(srcDir, "public"), outAbs); err != nil {
		return fmt.Errorf("copy public assets: %w", err)
	}

	if err := writeIndexHTML(indexHTML, outAbs, meta, entry); err != nil {
		return fmt.Errorf("write index.html: %w", err)
	}

	return nil
}

// metaImport is one entry of an output's metafile "imports" list. Kind is
// either "import-statement" (static) or "dynamic-import".
type metaImport struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// metaOutput mirrors the subset of esbuild's metafile JSON schema
// (https://esbuild.github.io/api/#metafile) this tool needs: which source
// entry point (if any) produced this output file, its associated CSS
// bundle (set only on a JS entry that statically imports CSS), and which
// other outputs it imports — statically ("import-statement", eagerly
// needed and safe to modulepreload) or dynamically ("dynamic-import",
// loaded on demand and must NOT be preloaded).
type metaOutput struct {
	EntryPoint string       `json:"entryPoint"`
	CSSBundle  string       `json:"cssBundle"`
	Imports    []metaImport `json:"imports"`
}

type metafile struct {
	Outputs map[string]metaOutput `json:"outputs"`
}

func parseMetafile(raw string) (*metafile, error) {
	var m metafile
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// entryOutput returns the output path whose entryPoint is entry. Both sides
// are compared as absolute paths rather than as raw strings: esbuild
// normalizes the entry point it echoes back into the metafile (it drops a
// leading "./", for instance), so a literal match against whatever the
// caller passed to -src isn't reliable.
func (m *metafile) entryOutput(entry string) (string, metaOutput, bool) {
	want, err := filepath.Abs(entry)
	if err != nil {
		return "", metaOutput{}, false
	}
	for p, o := range m.Outputs {
		if o.EntryPoint == "" {
			continue
		}
		got, err := filepath.Abs(o.EntryPoint)
		if err == nil && got == want {
			return p, o, true
		}
	}
	return "", metaOutput{}, false
}

// staticImportClosure walks the transitive closure of an output's
// "import-statement" (static) imports — the chunks the entry script needs
// synchronously and that are therefore safe to <link rel="modulepreload">.
// Dynamic-import chunks (echarts/topojson/qrcode) are deliberately excluded
// so they stay off the first-load path, matching the Vite build's #797
// behavior. The starting output itself is seeded into seen so a cycle back
// to it (esbuild does emit those for shared chunks) can't add a redundant
// preload for the entry script that's already in the page.
func (m *metafile) staticImportClosure(outputPath string) []string {
	seen := map[string]bool{outputPath: true}
	var order []string
	var walk func(string)
	walk = func(p string) {
		out, ok := m.Outputs[p]
		if !ok {
			return
		}
		for _, imp := range out.Imports {
			if imp.Kind != "import-statement" || seen[imp.Path] {
				continue
			}
			seen[imp.Path] = true
			order = append(order, imp.Path)
			walk(imp.Path)
		}
	}
	walk(outputPath)
	return order
}

// relFromOutDir returns p (an output path from the metafile) as a
// "./"-prefixed relative URL from outDir's own root — the same
// relative-path convention vite.config.js's `base: './'` produced, required
// for HA Ingress's dynamic path prefix.
func relFromOutDir(outDir, p string) (string, error) {
	outAbs, err := filepath.Abs(outDir)
	if err != nil {
		return "", err
	}
	pAbs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(outAbs, pAbs)
	if err != nil {
		return "", err
	}
	return "./" + filepath.ToSlash(rel), nil
}

// copyPublicDir copies Vite's former "public dir" convention verbatim into
// outDir: static files (manifest.json, sw.js, icon.png,
// countries-110m.json) that are referenced by relative URL/fetch rather than
// imported, and so must ship unbundled at the same top-level path. os.CopyFS
// recurses, so a nested file under public-src/public/ keeps its relative
// path instead of being silently skipped; the caller has already removed and
// recreated outDir, so CopyFS's own "don't overwrite" behavior can't trip.
func copyPublicDir(publicDir, outDir string) error {
	if _, err := os.Stat(publicDir); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return os.CopyFS(outDir, os.DirFS(publicDir))
}

// origScriptTag is the single module entry point in public-src/index.html
// (public-src/main.js's own `import './style.css'` is what esbuild extracts
// into the cssBundle output instead).
const origScriptTag = `<script type="module" src="./main.js"></script>`

// writeIndexHTML mirrors what Vite's HTML plugin does to public-src/index.html:
// remove the source module <script> tag and inject, just before </head>,
// the hashed entry script, modulepreload links for its static-import
// closure, and a stylesheet link for its CSS bundle.
func writeIndexHTML(srcIndex, outDir string, meta *metafile, entry string) error {
	raw, err := os.ReadFile(srcIndex)
	if err != nil {
		return err
	}
	html := string(raw)

	if !strings.Contains(html, origScriptTag) {
		return fmt.Errorf("%s: expected script tag %q not found", srcIndex, origScriptTag)
	}
	html = strings.Replace(html, origScriptTag, "", 1)

	outputPath, out, ok := meta.entryOutput(entry)
	if !ok {
		return fmt.Errorf("metafile has no output for entry point %s", entry)
	}

	var b strings.Builder
	scriptSrc, err := relFromOutDir(outDir, outputPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(&b, "  <script type=\"module\" crossorigin src=%q></script>\n", scriptSrc)

	for _, chunkPath := range meta.staticImportClosure(outputPath) {
		href, err := relFromOutDir(outDir, chunkPath)
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "  <link rel=\"modulepreload\" crossorigin href=%q>\n", href)
	}

	if out.CSSBundle != "" {
		href, err := relFromOutDir(outDir, out.CSSBundle)
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "  <link rel=\"stylesheet\" crossorigin href=%q>\n", href)
	}

	if !strings.Contains(html, "</head>") {
		return fmt.Errorf("%s: no </head> to inject build output before", srcIndex)
	}
	html = strings.Replace(html, "</head>", b.String()+"</head>", 1)

	return os.WriteFile(filepath.Join(outDir, "index.html"), []byte(html), 0o644)
}
