module github.com/mxkissnr/gaggiuino-local-profiler/go

go 1.26.0

// Pin the build toolchain to a patched 1.25.x so `go build`/`go test` in CI
// (actions/setup-go reads this file) and local dev pick up the Go standard-
// library security fixes govulncheck flags against a bare 1.25.0 — the
// golang:1.25-alpine Docker builder already floats to the latest patch.
toolchain go1.27.1

require (
	github.com/PuerkitoBio/goquery v1.13.0
	github.com/a-h/templ v0.3.1020
	github.com/eclipse/paho.mqtt.golang v1.5.1
	github.com/goccy/go-json v0.10.6
	github.com/kanrichan/resvg-go v0.0.1
	golang.org/x/crypto v0.57.0
	golang.org/x/image v0.46.0
	golang.org/x/net v0.59.0
	golang.org/x/time v0.16.0
	gopkg.in/yaml.v3 v3.0.1
	modernc.org/sqlite v1.58.0
	nhooyr.io/websocket v1.8.17
)

require (
	github.com/andybalholm/cascadia v1.3.4 // indirect
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/tetratelabs/wazero v1.4.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	modernc.org/libc v1.75.6 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
