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
// esbuild resolves the SPA's bare imports (echarts, chart.js/auto,
// topojson-client) out of node_modules, so the dependency tree is still a
// prerequisite — but only `npm ci`, never `npm run build`: no Vite bundle is
// involved. The Dockerfile copies node_modules out of a deps-only Node stage
// and CI's go-test job runs `npm ci` before the Go tests, both because the
// first CI round of #1033 failed with "Could not resolve" once the old Node
// stage stopped installing it.
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
	srcDir := flag.String("src", "../public-src", "frontend source directory (Vite's former root), relative to the current working directory")
	outDir := flag.String("out", "internal/webapp/dist", "build output directory, relative to the current working directory")
	nodeModules := flag.String("node-modules", "", "dependency tree for esbuild's bare-import resolution (default: node_modules next to -src)")
	flag.Parse()

	if err := run(*srcDir, *outDir, *nodeModules); err != nil {
		log.Fatalf("frontend-build: %v", err)
	}
}

// run is the whole build: validate the inputs, bundle public-src/main.ts with
// esbuild, copy public-src/public/ verbatim, then rewrite index.html's script
// tag into the hashed entry script + modulepreload links + stylesheet link.
func run(srcDir, outDir, nodeModulesFlag string) error {
	srcAbs, err := filepath.Abs(srcDir)
	if err != nil {
		return fmt.Errorf("resolve source dir: %w", err)
	}
	entryAbs := filepath.Join(srcAbs, "main.ts")
	indexAbs := filepath.Join(srcAbs, "index.html")
	for _, required := range []string{entryAbs, indexAbs} {
		if _, err := os.Stat(required); err != nil {
			return fmt.Errorf("required source file: %w", err)
		}
	}
	// Validated before any build work so a template that lost its entry tag
	// fails immediately, with a message naming the file, instead of after a
	// full bundle pass.
	srcHTML, err := os.ReadFile(indexAbs)
	if err != nil {
		return fmt.Errorf("read index.html: %w", err)
	}
	if !strings.Contains(string(srcHTML), origScriptTag) {
		return fmt.Errorf("%s: expected script tag %q not found", indexAbs, origScriptTag)
	}

	// The frontend root is the directory public-src/ lives in — Vite's former
	// root, where package.json and node_modules sit. It doubles as esbuild's
	// AbsWorkingDir, so path resolution and the metafile keys below don't
	// depend on the process's working directory: `go run ./cmd/frontend-build`
	// and `go test` (which runs with the package dir as CWD) behave the same.
	rootAbs := filepath.Dir(srcAbs)
	entryRel, err := filepath.Rel(rootAbs, entryAbs)
	if err != nil {
		return fmt.Errorf("resolve entry point relative to %s: %w", rootAbs, err)
	}

	nodeModulesAbs, err := nodeModulesDir(rootAbs, nodeModulesFlag)
	if err != nil {
		return err
	}

	// The output dir is resolved to an absolute path because esbuild writes
	// metafile keys relative to AbsWorkingDir (absolute for outputs outside
	// it, e.g. a -out under /tmp), so relFromOutDir has to anchor both sides
	// the same way to keep producing the "./…" URLs that index.html must
	// carry.
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
		EntryPoints:   []string{entryRel},
		AbsWorkingDir: rootAbs,
		// Explicit rather than relying on esbuild's own node_modules walk: in
		// the image the tree is COPYed in from the deps stage, and this keeps
		// that location authoritative (and greppable) instead of implicit.
		NodePaths:  []string{nodeModulesAbs},
		Bundle:     true,
		Splitting:  true,
		Platform:   api.PlatformBrowser,
		Format:     api.FormatESModule,
		Outdir:     assetsDir,
		Metafile:   true,
		Write:      true,
		EntryNames: "[name]-[hash]",
		ChunkNames: "[name]-[hash]",
		AssetNames: "[name]-[hash]",
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

	if err := copyPublicDir(filepath.Join(srcAbs, "public"), outAbs); err != nil {
		return fmt.Errorf("copy public assets: %w", err)
	}

	if err := writeIndexHTML(string(srcHTML), outAbs, meta, rootAbs, entryAbs); err != nil {
		return fmt.Errorf("write index.html: %w", err)
	}

	return nil
}

// nodeModulesDir returns the dependency tree esbuild resolves the SPA's bare
// imports (echarts, chart.js/auto, topojson-client) from: -node-modules when
// given, otherwise node_modules next to public-src. A missing tree is a hard
// error rather than a warning, because esbuild's own failure mode is a wall
// of "Could not resolve" lines that says nothing about the actual cause —
// exactly what #1033's first CI round produced once the old Node stage
// stopped installing the dependencies.
func nodeModulesDir(root, flagValue string) (string, error) {
	dir := flagValue
	if dir == "" {
		dir = filepath.Join(root, "node_modules")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("resolve node_modules: %w", err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("node_modules not found at %s (esbuild resolves the SPA's "+
			"echarts/chart.js/topojson-client imports from it): run `npm ci` in %s, or point "+
			"-node-modules at an existing dependency tree", abs, root)
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("node_modules path %s is not a directory", abs)
	}
	return abs, nil
}

// resolve turns a metafile path into an absolute one. esbuild reports both
// the entry point and the output paths relative to AbsWorkingDir (absolute
// for paths outside it), never relative to the process's working directory,
// so every path this command reads back has to be anchored to base.
func resolve(base, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(base, p)
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
// are normalized against base (AbsWorkingDir) instead of being compared as
// raw strings: esbuild echoes the entry point back in its own normalized form
// (relative to AbsWorkingDir, a leading "./" dropped), so a literal match
// against whatever the caller passed to -src isn't reliable.
func (m *metafile) entryOutput(base, entry string) (string, metaOutput, bool) {
	want := resolve(base, entry)
	for p, o := range m.Outputs {
		if o.EntryPoint == "" {
			continue
		}
		if resolve(base, o.EntryPoint) == want {
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

// relFromOutDir returns p (an output path from the metafile, relative to
// base/AbsWorkingDir) as a "./"-prefixed relative URL from outDir's own root
// — the same relative-path convention vite.config.js's `base: './'`
// produced, required for HA Ingress's dynamic path prefix.
func relFromOutDir(base, outDir, p string) (string, error) {
	outAbs, err := filepath.Abs(outDir)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(outAbs, resolve(base, p))
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
// (public-src/main.ts's own `import './style.css'` is what esbuild extracts
// into the cssBundle output instead).
const origScriptTag = `<script type="module" src="./main.ts"></script>`

// writeIndexHTML mirrors what Vite's HTML plugin does to public-src/index.html:
// strip the source module <script> tag and inject, just before </head>, the
// hashed entry script, modulepreload links for its static-import closure, and
// a stylesheet link for its CSS bundle. srcHTML is the source file run() has
// already validated to carry origScriptTag; entry and the metafile paths are
// resolved against base (AbsWorkingDir) when they're relative.
func writeIndexHTML(srcHTML, outDir string, meta *metafile, base, entry string) error {
	html := strings.Replace(srcHTML, origScriptTag, "", 1)

	outputPath, out, ok := meta.entryOutput(base, entry)
	if !ok {
		return fmt.Errorf("metafile has no output for entry point %s", entry)
	}

	var b strings.Builder
	scriptSrc, err := relFromOutDir(base, outDir, outputPath)
	if err != nil {
		return err
	}
	fmt.Fprintf(&b, "  <script type=\"module\" crossorigin src=%q></script>\n", scriptSrc)

	for _, chunkPath := range meta.staticImportClosure(outputPath) {
		href, err := relFromOutDir(base, outDir, chunkPath)
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "  <link rel=\"modulepreload\" crossorigin href=%q>\n", href)
	}

	if out.CSSBundle != "" {
		href, err := relFromOutDir(base, outDir, out.CSSBundle)
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "  <link rel=\"stylesheet\" crossorigin href=%q>\n", href)
	}

	if !strings.Contains(html, "</head>") {
		return fmt.Errorf("index.html has no </head> to inject build output before")
	}
	html = strings.Replace(html, "</head>", b.String()+"</head>", 1)

	return os.WriteFile(filepath.Join(outDir, "index.html"), []byte(html), 0o644)
}
