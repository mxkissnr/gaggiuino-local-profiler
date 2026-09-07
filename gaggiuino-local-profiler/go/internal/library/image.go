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
// fetchBeanImage and its exact-hostname allowlist — which the shots domain
// never needed.

// DefaultImageDir is re-exported from internal/img because many call sites
// (and internal/backup + internal/web) reference library.DefaultImageDir.
const DefaultImageDir = img.DefaultImageDir

// allowedImageHosts mirrors lib/constants.js's ALLOWED_IMAGE_HOSTS
// (ALLOWED_IMPORT_HOSTS plus cdn.shopify.com): bean images are only ever
// downloaded from an import source's own host or its CDN, never an
// arbitrary URL a client sends — this exact allowlist, not a generic SSRF
// DNS-resolution guard (unlike assertPublicHost in ssrf.go, used by the
// barcode-scan endpoint instead), is what fetchBeanImage below checks.
var allowedImageHosts = map[string]bool{
	"kaffeebraun.com":          true,
	"www.kaffeebraun.com":      true,
	"hoppenworth-ploch.de":     true,
	"www.hoppenworth-ploch.de": true,
	"elbgold.com":              true,
	"www.elbgold.com":          true,
	"cdn.shopify.com":          true,
}

// normalizeImageURL ports ImageService.js's normalizeImageUrl: a
// protocol-relative shop CDN URL ("//cdn.shopify.com/...") becomes https.
func normalizeImageURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "//") {
		return "https:" + trimmed
	}
	return trimmed
}

// isAllowedImageURL ports ImageService.js's isAllowedImageUrl: http(s) only,
// exact hostname match against allowedImageHosts.
func isAllowedImageURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && allowedImageHosts[u.Hostname()]
}

// fetchImageClient never follows redirects (maxRedirects: 0 in the Node
// original) — a redirect target isn't re-checked against the allowlist, so
// following it would reopen the exact SSRF surface the allowlist exists to
// close.
var fetchImageClient = &http.Client{
	Timeout: 8 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// fetchBeanImage ports ImageService.js's fetchBeanImage: downloads a bean
// image once, validating against the exact-hostname allowlist above (not
// assertPublicHost's DNS-resolution guard — see allowedImageHosts' doc
// comment), no redirect following, a size cap, and a content-type
// whitelist. The filename is derived from the (already-numeric) bean id,
// never from the URL. The downloaded bytes run through img.Save
// (ModeUpload), so the stored image is downscaled + metadata-stripped and
// gets a thumbnail, and a non-JPEG/PNG source may be converted. Returns the
// FINAL extension on success, "" on any failure (never an error — every
// caller treats this as best-effort, matching the Node original's
// `.catch(() => {})` fire-and-forget callers).
func fetchBeanImage(dir string, beanID int64, imageURL string) string {
	u := normalizeImageURL(imageURL)
	if u == "" || !isAllowedImageURL(u) {
		return ""
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, u, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent", "GLP/1.0 (Gaggiuino Local Profiler; private use)")
	resp, err := fetchImageClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	contentType := resp.Header.Get("Content-Type")
	if _, known := img.ContentTypeKnown(contentType); !known {
		return ""
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, img.MaxBytes+1))
	if err != nil || len(data) == 0 || len(data) > img.MaxBytes {
		return ""
	}
	ext, ok := img.Save(dir, "", beanID, data, contentType, img.ModeUpload)
	if !ok {
		return ""
	}
	return ext
}
