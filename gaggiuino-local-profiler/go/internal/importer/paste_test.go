package importer

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The literal, not the constant: a change to the header GLP sends must fail
// this test, not pass along with it.
const glpUserAgentLiteral = "GLP/1.0 (Gaggiuino Local Profiler; private use)"

// uaRecorder records the User-Agent of every hop and forwards to the queued
// canned responses.
type uaRecorder struct {
	next http.RoundTripper
	uas  []string
}

func (r *uaRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	r.uas = append(r.uas, req.Header.Get("User-Agent"))
	return r.next.RoundTrip(req)
}

func recordUserAgents(t *testing.T, h *Handlers, q *queueRT) *uaRecorder {
	t.Helper()
	rec := &uaRecorder{next: q}
	h.fetch.client.Transport = rec
	return rec
}

func checkUserAgents(t *testing.T, uas []string, want int) {
	t.Helper()
	if len(uas) != want {
		t.Fatalf("recorded %d requests, want %d: %v", len(uas), want, uas)
	}
	for _, ua := range uas {
		if ua != glpUserAgentLiteral {
			t.Errorf("User-Agent = %q, want %q", ua, glpUserAgentLiteral)
		}
		if strings.Contains(ua, "Mozilla") {
			t.Errorf("User-Agent %q looks like a browser", ua)
		}
	}
}

func readFixtureText(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("reading fixture %s: %v", name, err)
	}
	return string(b)
}

func pasteBody(t *testing.T, rawURL, text string) string {
	t.Helper()
	b, err := json.Marshal(map[string]any{"url": rawURL, "text": text})
	if err != nil {
		t.Fatalf("encoding request body: %v", err)
	}
	return string(b)
}

func postPaste(t *testing.T, m *http.ServeMux, rawURL, text string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, m, http.MethodPost, "/api/import/paste", pasteBody(t, rawURL, text))
}

// TestImportUserAgentIsGLP pins GLP's own identity on every hop of an import
// and of a paste: no browser disguise, ever.
func TestImportUserAgentIsGLP(t *testing.T) {
	t.Run("built-in json fetch", func(t *testing.T) {
		h, q, m := newHandlers(t, nil, jsonResp(map[string]any{"title": "BOMBE", "vendor": "elbgold", "description": ""}))
		rec := recordUserAgents(t, h, q)
		do(t, m, http.MethodGet, urlq("https://elbgold.com/products/bombe"), "")
		checkUserAgents(t, rec.uas, 1)
	})

	t.Run("generic json plus html", func(t *testing.T) {
		h, q, m := newHandlers(t, nil,
			jsonResp(map[string]any{"title": "Flower Power", "vendor": "adventurous", "description": ""}),
			htmlResp("<html><body></body></html>"),
		)
		rec := recordUserAgents(t, h, q)
		do(t, m, http.MethodGet, urlq("https://sprout.example/products/flower-power"), "")
		checkUserAgents(t, rec.uas, 2)
	})

	t.Run("redirect hop", func(t *testing.T) {
		h, q, m := newHandlers(t, nil,
			cannedResp{status: 302, headers: map[string]string{"Location": "https://shop.example/products/x-redirect.js"}},
			jsonResp(map[string]any{"title": "Redirected", "vendor": "shop", "description": ""}),
			htmlResp("<html><body></body></html>"),
		)
		rec := recordUserAgents(t, h, q)
		do(t, m, http.MethodGet, urlq("https://shop.example/products/x"), "")
		checkUserAgents(t, rec.uas, 3)
	})

	t.Run("paste with enrichment", func(t *testing.T) {
		h, q, m := newHandlers(t, nil, htmlResp("<html><body></body></html>"))
		rec := recordUserAgents(t, h, q)
		got := postPaste(t, m, "https://shop.example/products/x", `{"title":"Pasted","vendor":"shop"}`)
		if got.Code != 200 {
			t.Fatalf("code = %d, body = %s", got.Code, got.Body.String())
		}
		checkUserAgents(t, rec.uas, 1)
	})
}

// rateLimitCase is one row of the GET contract table. dataURL is the exact
// productDataUrl the answer must carry, or "" when the field must be absent.
type rateLimitCase struct {
	name    string
	url     string
	resps   []cannedResp
	status  int
	code    string
	dataURL string
	method  string
	bean    string
	calls   int
}

// TestImportURL_ShopRateLimited walks the contract table: a shop's 429 is
// reported as 502 (GLP's own limiter owns 429), never retried, and the upstream
// body is never echoed.
func TestImportURL_ShopRateLimited(t *testing.T) {
	const marker = "local_rate_limited"
	limited := func() cannedResp {
		return cannedResp{status: http.StatusTooManyRequests, body: `{"error":"` + marker + `"}`}
	}
	pageWithJSONLD := func() cannedResp {
		ld, _ := json.Marshal(map[string]any{
			"@context": "https://schema.org", "@type": "Product",
			"name": "Colombia Huila", "description": "Notes of caramel.",
			"brand": map[string]any{"name": "Some Roastery"},
		})
		return htmlResp(`<html><head><script type="application/ld+json">` + string(ld) + `</script></head><body></body></html>`)
	}

	cases := []rateLimitCase{
		{
			name:    "built-in shopify json 429",
			url:     "https://elbgold.com/products/bombe",
			resps:   []cannedResp{limited()},
			status:  502,
			code:    codeShopRateLimited,
			dataURL: "https://elbgold.com/products/bombe.js",
			calls:   1,
		},
		{
			name:   "built-in html shop page 429",
			url:    "https://kaffeebraun.com/products/x",
			resps:  []cannedResp{limited()},
			status: 502,
			code:   codeShopRateLimited,
			calls:  1,
		},
		{
			name:    "generic json 429 then page 429",
			url:     "https://shop.example/products/x",
			resps:   []cannedResp{limited(), limited()},
			status:  502,
			code:    codeShopRateLimited,
			dataURL: "https://shop.example/products/x.js",
			calls:   2,
		},
		{
			name:    "generic json 429 then page without product data",
			url:     "https://shop.example/products/x",
			resps:   []cannedResp{limited(), htmlResp("<html><body>nothing here</body></html>")},
			status:  502,
			code:    codeShopRateLimited,
			dataURL: "https://shop.example/products/x.js",
			calls:   2,
		},
		{
			name:    "generic json 429 then page with json-ld",
			url:     "https://shop.example/products/x",
			resps:   []cannedResp{limited(), pageWithJSONLD()},
			status:  200,
			dataURL: "https://shop.example/products/x.js",
			method:  "jsonld",
			bean:    "Colombia Huila",
			calls:   2,
		},
		{
			name:   "generic json 404 then page 429",
			url:    "https://shop.example/products/x",
			resps:  []cannedResp{{status: http.StatusNotFound}, limited()},
			status: 502,
			code:   codeShopRateLimited,
			calls:  2,
		},
		{
			name:   "json 200 enrichment page 429",
			url:    "https://shop.example/products/x",
			resps:  []cannedResp{jsonResp(map[string]any{"title": "Kept Bean", "vendor": "shop", "description": ""}), limited()},
			status: 200,
			method: "generic-shopify",
			bean:   "Kept Bean",
			calls:  2,
		},
		{
			name:   "other status stays 500",
			url:    "https://shop.example/products/x",
			resps:  []cannedResp{{status: http.StatusInternalServerError}, {status: http.StatusInternalServerError}},
			status: 500,
			calls:  2,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, q, m := newHandlers(t, nil, c.resps...)
			rec := do(t, m, http.MethodGet, urlq(c.url), "")
			if rec.Code != c.status {
				t.Fatalf("code = %d, want %d (body %s)", rec.Code, c.status, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), marker) {
				t.Errorf("upstream body leaked: %s", rec.Body.String())
			}
			body := jsonBody(t, rec)
			if c.code != "" && body["code"] != c.code {
				t.Errorf("code field = %v, want %v", body["code"], c.code)
			}
			gotDataURL, hasDataURL := body["productDataUrl"]
			if c.dataURL != "" {
				if !hasDataURL || gotDataURL != c.dataURL {
					t.Errorf("productDataUrl = %v (present %v), want %v", gotDataURL, hasDataURL, c.dataURL)
				}
			} else if hasDataURL {
				t.Errorf("productDataUrl should be absent, got %v", gotDataURL)
			}
			if c.method != "" && body["importMethod"] != c.method {
				t.Errorf("importMethod = %v, want %v", body["importMethod"], c.method)
			}
			if c.bean != "" && body["name"] != c.bean {
				t.Errorf("name = %v, want %v", body["name"], c.bean)
			}
			if len(q.calls) != c.calls {
				t.Errorf("calls = %v, want %d (no retry)", q.calls, c.calls)
			}
		})
	}
}

// pasteCase is one fixture pair: the product JSON, the optional page, and the
// custom domains a test saves. pages is how many requests a paste may make.
type pasteCase struct {
	name    string
	url     string
	json    string
	html    string
	domains []string
	pages   int
}

// TestPaste_SameAsFetch requires the paste route to produce the same decoded
// body as the fetch route for the same product data. Built-in parsers make no
// request on paste; the generic and custom paths make exactly one, for the page.
func TestPaste_SameAsFetch(t *testing.T) {
	cases := []pasteCase{
		{
			name: "builtin hoplo",
			url:  "https://hoppenworth-ploch.de/products/shyira-washed-ruanda",
			json: "hoplo-shyira.json",
		},
		{
			name: "builtin elbgold",
			url:  "https://elbgold.com/products/bombe",
			json: "elbgold-bombe.json",
		},
		{
			name:    "custom domain",
			url:     "https://shop.example.com/products/flower-power",
			json:    "sprout-flower-power.json",
			html:    "sprout-flower-power.html",
			domains: []string{"shop.example.com"},
			pages:   1,
		},
		{
			name:  "generic host",
			url:   "https://sproutcoffeeroasters.example/products/flower-power",
			json:  "sprout-flower-power.json",
			html:  "sprout-flower-power.html",
			pages: 1,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			jsonText := readFixtureText(t, c.json)
			htmlText := ""
			if c.html != "" {
				htmlText = readFixtureText(t, c.html)
			}

			getResps := []cannedResp{{status: 200, body: jsonText}}
			pasteResps := []cannedResp{}
			if htmlText != "" {
				getResps = append(getResps, htmlResp(htmlText))
				pasteResps = append(pasteResps, htmlResp(htmlText))
			}

			getH, _, getM := newHandlers(t, nil, getResps...)
			pasteH, pasteQ, pasteM := newHandlers(t, nil, pasteResps...)
			if c.domains != nil {
				settings := Settings{DisabledProviders: []string{}, CustomShopifyDomains: c.domains}
				if err := getH.repo.SaveSettings(settings); err != nil {
					t.Fatal(err)
				}
				if err := pasteH.repo.SaveSettings(settings); err != nil {
					t.Fatal(err)
				}
			}

			getRec := do(t, getM, http.MethodGet, urlq(c.url), "")
			if getRec.Code != 200 {
				t.Fatalf("GET code = %d, body = %s", getRec.Code, getRec.Body.String())
			}

			pasteRec := postPaste(t, pasteM, c.url, jsonText)
			if pasteRec.Code != 200 {
				t.Fatalf("paste code = %d, body = %s", pasteRec.Code, pasteRec.Body.String())
			}

			if !reflect.DeepEqual(jsonBody(t, getRec), jsonBody(t, pasteRec)) {
				t.Errorf("bodies differ:\nGET   %s\nPASTE %s", getRec.Body.String(), pasteRec.Body.String())
			}
			if len(pasteQ.calls) != c.pages {
				t.Errorf("paste calls = %v, want %d", pasteQ.calls, c.pages)
			}
		})
	}
}

// hostCase is one (url, expected parser) row.
type hostCase struct {
	name    string
	url     string
	domains []string
	disable []string
	method  string
	source  string
	pages   int
}

// TestPaste_HostSelectsParser proves the host of the original URL — never
// anything inside the pasted text — picks the parser.
func TestPaste_HostSelectsParser(t *testing.T) {
	const pastedText = `{"title":"Foreign Bean - Brasilien","vendor":"Some Roaster",` +
		`"url":"https://elbgold.com/products/foreign-bean","description":"<p>Noten von Kirsche.</p>","tags":["Espresso"]}`

	cases := []hostCase{
		{
			name:   "hoppenworth built-in",
			url:    "https://hoppenworth-ploch.de/products/foreign-bean",
			method: "builtin:hoppenworth-ploch",
			source: "hoppenworth-ploch.de",
		},
		{
			name:   "elbgold built-in",
			url:    "https://elbgold.com/products/foreign-bean",
			method: "builtin:elbgold",
			source: "elbgold.com",
		},
		{
			name:    "custom domain",
			url:     "https://shop.example.com/products/foreign-bean",
			domains: []string{"shop.example.com"},
			method:  "custom-shopify",
			source:  "shop.example.com",
			pages:   1,
		},
		{
			name:   "generic host",
			url:    "https://random.example/products/foreign-bean",
			method: "generic-shopify",
			source: "random.example",
			pages:  1,
		},
		{
			name:    "disabled elbgold falls to generic",
			url:     "https://elbgold.com/products/foreign-bean",
			disable: []string{"elbgold"},
			method:  "generic-shopify",
			source:  "elbgold.com",
			pages:   1,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resps := make([]cannedResp, c.pages)
			for i := range resps {
				resps[i] = htmlResp("<html><body></body></html>")
			}
			h, q, m := newHandlers(t, nil, resps...)
			if c.domains != nil || c.disable != nil {
				settings := Settings{
					DisabledProviders:    append([]string{}, c.disable...),
					CustomShopifyDomains: append([]string{}, c.domains...),
				}
				if err := h.repo.SaveSettings(settings); err != nil {
					t.Fatal(err)
				}
			}

			rec := postPaste(t, m, c.url, pastedText)
			if rec.Code != 200 {
				t.Fatalf("code = %d, body = %s", rec.Code, rec.Body.String())
			}
			body := jsonBody(t, rec)
			if body["importMethod"] != c.method {
				t.Errorf("importMethod = %v, want %v", body["importMethod"], c.method)
			}
			if body["source"] != c.source {
				t.Errorf("source = %v, want %v", body["source"], c.source)
			}
			if len(q.calls) != c.pages {
				t.Errorf("calls = %v, want %d", q.calls, c.pages)
			}
		})
	}
}

// rejectCase is one (url, text, expected message) row.
type rejectCase struct {
	name string
	url  string
	text string
	want string
}

// TestPaste_Rejected covers every 400 row. Nothing is fetched, nothing is
// stored, and the pasted text never reaches the response.
func TestPaste_Rejected(t *testing.T) {
	const marker = "PASTED_MARKER_9f3"
	const shopURL = "https://shop.example/products/x"

	cases := []rejectCase{
		{name: "empty text", url: shopURL, text: "", want: "invalid product data"},
		{name: "spaces", url: shopURL, text: "   \n\t ", want: "invalid product data"},
		{name: "html", url: shopURL, text: "<html>" + marker + "</html>", want: "invalid product data"},
		{name: "array", url: shopURL, text: "[]", want: "invalid product data"},
		{name: "null", url: shopURL, text: "null", want: "invalid product data"},
		{name: "string", url: shopURL, text: `"` + marker + `"`, want: "invalid product data"},
		{name: "empty object", url: shopURL, text: "{}", want: "invalid product data"},
		{name: "empty title", url: shopURL, text: `{"title":"","m":"` + marker + `"}`, want: "invalid product data"},
		{name: "numeric title", url: shopURL, text: `{"title":5}`, want: "invalid product data"},
		{name: "truncated", url: shopURL, text: `{"title":"` + marker + `"`, want: "invalid product data"},
		{name: "two objects", url: shopURL, text: `{"title":"` + marker + `"}{"title":"b"}`, want: "invalid product data"},
		{name: "object then text", url: shopURL, text: `{"title":"` + marker + `"} trailing`, want: "invalid product data"},
		{name: "http url", url: "http://shop.example/products/x", text: `{"title":"` + marker + `"}`, want: "unsupported protocol"},
		{name: "relative url", url: "/products/x", text: `{"title":"` + marker + `"}`, want: "invalid url"},
		{name: "missing url", url: "", text: `{"title":"` + marker + `"}`, want: "url required"},
		{name: "no products path", url: "https://shop.example/collections/x", text: `{"title":"` + marker + `"}`, want: pasteUnavailableMessage},
		{name: "html shop", url: "https://kaffeebraun.com/products/x", text: `{"title":"` + marker + `"}`, want: pasteUnavailableMessage},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, q, m := newHandlers(t, nil)
			before := h.repo.GetSettings()
			rec := postPaste(t, m, c.url, c.text)
			if rec.Code != 400 {
				t.Fatalf("code = %d, want 400 (body %s)", rec.Code, rec.Body.String())
			}
			if body := jsonBody(t, rec); body["error"] != c.want {
				t.Errorf("error = %v, want %v", body["error"], c.want)
			}
			if strings.Contains(rec.Body.String(), marker) {
				t.Errorf("pasted text leaked into the response: %s", rec.Body.String())
			}
			if rec.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
			}
			if len(q.calls) != 0 {
				t.Errorf("no upstream request expected, got %v", q.calls)
			}
			if !reflect.DeepEqual(h.repo.GetSettings(), before) {
				t.Errorf("settings changed to %+v", h.repo.GetSettings())
			}
		})
	}
}

// paddedDocument returns a valid product JSON document of exactly size bytes,
// padded with interior whitespace so the text cap, not the shape, decides.
func paddedDocument(t *testing.T, size int) string {
	t.Helper()
	const head = `{"title":"Padded",`
	const tail = `"vendor":"elbgold"}`
	pad := size - len(head) - len(tail)
	if pad < 0 {
		t.Fatalf("size %d too small", size)
	}
	return head + strings.Repeat(" ", pad) + tail
}

func TestPaste_SizeLimit(t *testing.T) {
	_, q, m := newHandlers(t, nil)

	rec := postPaste(t, m, "https://elbgold.com/products/padded", paddedDocument(t, maxPasteBytes))
	if rec.Code != 200 {
		t.Fatalf("at the limit: code = %d, body = %s", rec.Code, rec.Body.String())
	}

	rec = postPaste(t, m, "https://elbgold.com/products/padded", paddedDocument(t, maxPasteBytes+1))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("one byte over: code = %d, body = %s", rec.Code, rec.Body.String())
	}

	huge := `{"url":"https://elbgold.com/products/padded","text":"` + strings.Repeat("a", maxPasteBody) + `"}`
	rec = do(t, m, http.MethodPost, "/api/import/paste", huge)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("body over the cap: code = %d, body = %s", rec.Code, rec.Body.String())
	}

	if len(q.calls) != 0 {
		t.Errorf("no upstream request expected, got %v", q.calls)
	}
}

func TestPaste_AcceptsSurroundingWhitespaceAndBOM(t *testing.T) {
	_, _, m := newHandlers(t, nil)
	text := " \u00a0\ufeff\n\t" + `{"title":"BOMBE","vendor":"elbgold","description":""}` + "\n\ufeff \u00a0"
	rec := postPaste(t, m, "https://elbgold.com/products/bombe", text)
	if rec.Code != 200 {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if body := jsonBody(t, rec); body["name"] != "BOMBE" {
		t.Errorf("name = %v", body["name"])
	}
}

// enrichmentCase is one failing page response.
type enrichmentCase struct {
	name string
	resp cannedResp
}

// TestPaste_EnrichmentFailureKeepsBean pins #480's behavior on the paste route:
// a failed page fetch keeps the pasted bean.
func TestPaste_EnrichmentFailureKeepsBean(t *testing.T) {
	cases := []enrichmentCase{
		{name: "page 429", resp: cannedResp{status: http.StatusTooManyRequests, body: "local_rate_limited"}},
		{name: "page transport error", resp: cannedResp{err: errors.New("timeout")}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, m := newHandlers(t, nil, c.resp)
			text := `{"title":"Flower Power","vendor":"adventurous","description":"","price":1800}`
			rec := postPaste(t, m, "https://sprout.example/products/flower-power", text)
			if rec.Code != 200 {
				t.Fatalf("code = %d, body = %s", rec.Code, rec.Body.String())
			}
			body := jsonBody(t, rec)
			if body["name"] != "Flower Power" || body["importMethod"] != "generic-shopify" {
				t.Errorf("body = %v", body)
			}
			if _, ok := body["process"]; ok {
				t.Errorf("process should be absent, got %v", body["process"])
			}
		})
	}
}

func TestPaste_SSRFPrivateAddress(t *testing.T) {
	_, q, m := newHandlers(t, nil)
	setDNS(t, map[string]string{"internal-service.example": "10.1.2.3"})
	rec := postPaste(t, m, "https://internal-service.example/products/x", `{"title":"Private","vendor":"x"}`)
	if rec.Code != 400 || jsonBody(t, rec)["error"] != "blocked address" {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(q.calls) != 0 {
		t.Errorf("no upstream request expected, got %v", q.calls)
	}
}

// TestPaste_ImageURLSchemes: the pasted image URL goes through the same scheme
// filter as a fetched one, so a javascript: URL never reaches the form.
func TestPaste_ImageURLSchemes(t *testing.T) {
	_, _, m := newHandlers(t, nil, htmlResp("<html><body></body></html>"))
	text := `{"title":"Flower Power","vendor":"adventurous","description":"","featured_image":"javascript:alert(1)"}`
	rec := postPaste(t, m, "https://sprout.example/products/flower-power", text)
	if rec.Code != 200 {
		t.Fatalf("code = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got, ok := jsonBody(t, rec)["imageUrl"]; !ok || got != "" {
		t.Errorf("imageUrl = %v (present %v), want empty", got, ok)
	}
}
