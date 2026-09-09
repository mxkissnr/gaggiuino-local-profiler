# Phase 2a (#901): templ generate is a required codegen step before
# build/vet/test can see internal/web/templates' generated _templ.go files
# (not committed — see internal/web/templates/generate.go and go/README.md's
# Frontend section). Every target below runs it first so `make build`/
# `make test`/`make vet` work the same whether or not generate has already
# run.

# `make frontend` builds the production SPA (Phase 1, #901): it runs the
# repo-root Vite build and stages gaggiuino-local-profiler/public into
# internal/webapp/dist/, which internal/webapp embeds via `//go:embed
# all:dist`. Run it before `make build` for a real binary. CI's plain
# `go build ./...` / `go test ./...` gate does NOT run it — it resolves the
# embed against the committed dist/index.html placeholder instead (see
# internal/webapp/doc.go). The Dockerfile does the equivalent in its own
# `frontend` stage.

.PHONY: generate build vet test fmt-check clean-generated frontend

# `templ generate` (invoked below via go generate) is a separate CLI
# binary, not something go.mod/go.sum pull in on their own — see
# go/README.md's "Codegen" section. Install it on demand rather than
# unconditionally, so a runner that already has it on PATH never makes a
# network call just to build.
generate:
	command -v templ >/dev/null 2>&1 || go install github.com/a-h/templ/cmd/templ@latest
	go generate ./...

build: generate
	go build ./...

vet: generate
	go vet ./...

test: generate
	go test ./...

fmt-check: generate
	gofmt -l .

clean-generated:
	find . -name '*_templ.go' -delete

frontend:
	cd .. && npm ci && npm run build
	rm -rf internal/webapp/dist
	mkdir -p internal/webapp/dist
	cp -a ../public/. internal/webapp/dist/
