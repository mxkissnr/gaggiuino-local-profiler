package importer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file ports routes/import.js's safeGet(startUrl, opts): a bounded,
// SSRF-hardened fetch applied to every hop — https-only, a
// private/loopback/link-local check before each request (initial URL and
// every redirect target; redirects are never auto-followed), an 8s timeout,
// and the 5 MiB IMPORT_FETCH_MAX_BYTES size cap (lib/constants.js).

const (
	importFetchMaxBytes = 5 * 1024 * 1024
	fetchTimeout        = 8 * time.Second
	fetchUserAgent      = "GLP/1.0 (Gaggiuino Local Profiler; private use)"
	maxRedirectHops     = 3
)

var errTooManyRedirects = errors.New("too many redirects")

// fetchResult carries one hop's final response.
type fetchResult struct {
	status int
	body   []byte
}

// data ports axios's default transformResponse: try JSON.parse, fall back to
// the raw string. Returns map[string]any / []any for JSON, or a string.
func (r fetchResult) data() any {
	var v any
	if err := json.Unmarshal(r.body, &v); err == nil {
		return v
	}
	return string(r.body)
}

// dataString mirrors the Node HTML paths' `typeof r.data === 'string' ? r.data : ”`.
func (r fetchResult) dataString() string {
	if s, ok := r.data().(string); ok {
		return s
	}
	return ""
}

// dataObject returns the body as a map when it parsed as a JSON object, else nil.
func (r fetchResult) dataObject() map[string]any {
	if m, ok := r.data().(map[string]any); ok {
		return m
	}
	return nil
}

// fetcher is the http.Client seam — tests inject a RoundTripper that serves
// canned responses without a real socket.
type fetcher struct{ client *http.Client }

// importDialer pins safeGet's actual TCP connection to the IP
// assertPublicHostResolved just approved for the current hop, instead of
// letting net/http's transport re-resolve the hostname independently at
// connect time (#987) — via the shared netguard.GuardedDialer (also used
// by internal/machines/http.go and internal/mqtt/client.go). safeGet's
// assertPublicHost call (per hop, before doOnce) is the fast-fail check;
// this is the one that's actually atomic with the connection.
var importDialer = netguard.NewGuardedDialer(assertPublicHostResolved)

func newFetcher() *fetcher {
	return &fetcher{client: &http.Client{
		Timeout:       fetchTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     &http.Transport{DialContext: importDialer.DialContext},
	}}
}

func (f *fetcher) safeGet(ctx context.Context, startURL string) (fetchResult, error) {
	current := startURL
	for hop := 0; hop <= maxRedirectHops; hop++ {
		parsed, err := url.Parse(current)
		if err != nil {
			return fetchResult{}, fmt.Errorf("invalid url: %w", err)
		}
		if parsed.Scheme != "https" {
			return fetchResult{}, errors.New("unsupported protocol")
		}
		if err := assertPublicHost(ctx, parsed.Hostname()); err != nil {
			return fetchResult{}, err
		}

		res, redirectTo, err := f.doOnce(ctx, current, parsed)
		if err != nil {
			return fetchResult{}, err
		}
		if redirectTo != "" {
			current = redirectTo
			continue
		}
		return res, nil
	}
	return fetchResult{}, errTooManyRedirects
}

// doOnce performs one hop. A 3xx returns ("", redirectURL, nil); a 2xx
// returns (result, "", nil); anything else returns an error (axios
// validateStatus: s < 400).
func (f *fetcher) doOnce(ctx context.Context, rawURL string, base *url.URL) (fetchResult, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fetchResult{}, "", err
	}
	req.Header.Set("User-Agent", fetchUserAgent)

	resp, err := f.client.Do(req)
	if err != nil {
		return fetchResult{}, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc := resp.Header.Get("Location")
		if loc == "" {
			return fetchResult{}, "", errors.New("redirect without location")
		}
		next, err := base.Parse(loc)
		if err != nil {
			return fetchResult{}, "", err
		}
		return fetchResult{}, next.String(), nil
	}
	if resp.StatusCode >= 400 {
		return fetchResult{}, "", fmt.Errorf("request failed with status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, importFetchMaxBytes+1))
	if err != nil {
		return fetchResult{}, "", err
	}
	if len(body) > importFetchMaxBytes {
		return fetchResult{}, "", errors.New("response exceeds max content length")
	}
	return fetchResult{status: resp.StatusCode, body: body}, "", nil
}

// hostForImport ports routes/import.js's
// `parsed.hostname.replace(/^www\./, ”).toLowerCase()`.
func hostForImport(u *url.URL) string {
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}
