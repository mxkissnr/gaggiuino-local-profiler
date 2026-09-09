package web

import (
	"log"
	"net/http"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// This file is Phase 2e's (#901) Backup-domain page: GET /backup only — a
// download link for the already-existing GET /api/backup export
// (internal/backup/handlers.go), plus an explicit note that restore isn't
// built into this page.
//
// # Scope decision: no restore upload UI in this phase
//
// The dispatch brief for this phase explicitly left the restore-upload
// question to this package's own judgment: build a real <input type=file>+
// htmx upload, or defer to the JSON API with a documented reason. Deferred,
// for two concrete reasons, not just "less code to write":
//
//  1. POST /api/restore's request shape doesn't fit a plain HTML form. The
//     legacy JSON path needs a parsed backup.json body (a browser can't
//     multipart-upload a file and have this package's own handler re-shape
//     it into that exact body without client-side JS reading the file);
//     the zip path needs X-GLP-Sections/X-GLP-Passphrase/X-GLP-Dry-Run as
//     *headers* next to a raw application/zip body (see
//     internal/backup/doc.go and public-src/components/backup-modal.js's
//     postRestore) — neither is expressible as a plain
//     <form method="POST" enctype="multipart/form-data">, which is the one
//     upload mechanism that needs no first-party JS. Doing this properly
//     needs the same fetch()-driven flow backup-modal.js already
//     implements (~340 lines: zip-signature sniffing, a dry-run round trip
//     to build the section-presence checklist, a debounced preview, then a
//     confirmed second POST) — a page-specific JS module, which is a much
//     larger and more novel piece of work than every other Phase 2 write
//     action (a single htmx hx-post) and belongs in its own follow-up, not
//     improvised into this one.
//  2. A dry-run preview (showing what a restore would change before it's
//     applied) is what makes restore safe to expose in a UI at all — without
//     it this page would be offering a destructive, irreversible action
//     (restore.go's own doc comment: sections apply sequentially, not in
//     one transaction) with no confirmation step beyond "are you sure",
//     which is a worse experience than pointing at the JSON API directly.
//
// See templates/backup.templ's own doc comment for the same reasoning
// surfaced to the page's own reader, not just this source comment.
type BackupHandlers struct{}

// NewBackupHandlers builds BackupHandlers — no dependencies: this page
// reads/writes nothing itself, it only links to the existing
// GET /api/backup handler.
func NewBackupHandlers() *BackupHandlers {
	return &BackupHandlers{}
}

// RegisterRoutes registers GET /backup onto mux — not prefixed with /api/,
// for the same GET/HEAD-auth-bypass reason handlers.go's RegisterRoutes
// documents. This page has no htmx write action, so there is nothing else
// to gate behind auth.RequireToken here.
func (h *BackupHandlers) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /backup", h.backupPage)
}

func (h *BackupHandlers) backupPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := templates.BackupPage().Render(r.Context(), w); err != nil {
		log.Printf("web: rendering /backup: %v", err)
	}
}
