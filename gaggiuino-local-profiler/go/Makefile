# `make frontend` builds the production SPA (Phase 1, #901) — since #1033
# with esbuild's Go API (cmd/frontend-build), no npm/Vite involved: it
# bundles ../public-src into internal/webapp/dist/, which internal/webapp
# embeds via `//go:embed all:dist`. Run it before `make build` for a real
# binary. CI's plain `go build ./...` / `go test ./...` gate does NOT run it
# — it resolves the embed against the committed dist/index.html placeholder
# instead (see internal/webapp/doc.go). The Dockerfile's builder stage runs
# the same command.

.PHONY: build vet test fmt-check frontend

build:
	go build ./...

vet:
	go vet ./...

test:
	go test ./...

fmt-check:
	gofmt -l .

# Bundles ../public-src into internal/webapp/dist with esbuild's Go API
# (#1033). cmd/frontend-build wipes and recreates the output dir itself, so
# no staging/cleanup steps are needed here.
frontend:
	go run ./cmd/frontend-build
