package library

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
)

// The upload / serve / delete / filename helpers this file used to carry
// now live in internal/img, shared with internal/shots and internal/backup
// (see that package's doc.go). What stays here is the URL-download half —
// downloadBeanImage and its exact-hostname allowlist — which the shots domain
// never needed.

// DefaultImageDir is re-exported from internal/img because many call sites
// (and internal/backup) reference library.DefaultImageDir. A
// var so it picks up img's GLP_IMAGE_DIR override (see internal/img/img.go).
var DefaultImageDir = img.DefaultImageDir

// allowedImageHosts is the allowlist (ALLOWED_IMPORT_HOSTS plus
// cdn.shopify.com): bean images are only ever downloaded from an import
// source's own host or its CDN, never an arbitrary URL a client sends.
var allowedImageHosts = map[string]bool{
	"kaffeebraun.com":          true,
	"www.kaffeebraun.com":      true,
	"hoppenworth-ploch.de":     true,
	"www.hoppenworth-ploch.de": true,
	"elbgold.com":              true,
	"www.elbgold.com":          true,
	"cdn.shopify.com":          true,
}

// normalizeImageURL turns a protocol-relative shop CDN URL
// ("//cdn.shopify.com/...") into https.
func normalizeImageURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "//") {
		return "https:" + trimmed
	}
	return trimmed
}

// isAllowedImageURL accepts http(s) only, with exact hostname match against
// allowedImageHosts.
func isAllowedImageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && allowedImageHosts[u.Hostname()]
}

// fetchImageClient never follows redirects — a redirect target isn't
// re-checked against the allowlist, so following it would reopen the exact
// SSRF surface the allowlist exists to close.
var fetchImageClient = &http.Client{
	Timeout: 8 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// downloadBeanImage fetches a bean image once, validating against the
// exact-hostname allowlist above plus assertPublicHost's pre-flight check,
// with no redirect following, a size
// cap, and a content-type whitelist. It returns the downloaded body and its
// content type for the caller to store; the filename is derived from the
// (already-numeric) bean id, never from the URL. Returns (nil, "") on any
// failure (never an error — every caller treats this as best-effort).
func downloadBeanImage(imageURL string) (data []byte, contentType string) {
	u := normalizeImageURL(imageURL)
	if u == "" || !isAllowedImageURL(u) {
		return nil, ""
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return nil, ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	// The exact-hostname allowlist above (isAllowedImageURL) is the primary
	// SSRF defense. assertPublicHost adds a pre-flight check that the host
	// does not resolve to an internal address; fetchImageClient resolves it
	// again when it dials, so this is not a DNS-rebinding guard (see ssrf.go).
	if err := assertPublicHost(ctx, parsed.Hostname()); err != nil {
		return nil, ""
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, ""
	}
	req.Header.Set("User-Agent", "GLP/1.0 (Gaggiuino Local Profiler; private use)")
	resp, err := fetchImageClient.Do(req)
	if err != nil {
		return nil, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, ""
	}
	contentType = resp.Header.Get("Content-Type")
	if _, known := img.ContentTypeKnown(contentType); !known {
		return nil, ""
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, img.MaxBytes+1))
	if err != nil || len(data) == 0 || len(data) > img.MaxBytes {
		return nil, ""
	}
	return data, contentType
}
