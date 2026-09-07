package achievements

import "encoding/base64"

// This file ports lib/achievements/secrets.js: the 6 secret badges' name/
// description text, deliberately kept out of registry.go and out of the
// public i18n bundle.
//
// What the base64 here does and does NOT do (verbatim from the Node file's
// header): GLP is open source, so nothing server-side is secret from anyone
// willing to run the code and call decode() themselves — this is
// obfuscation, not encryption. What it DOES stop is the common way a stamp
// card spoils itself: the name/description sitting in plaintext in the
// public i18n bundle that ships to every browser on every page load. Keeping
// the encoded copy server-side and only decoding it into an API response
// after the handler confirms the badge is unlocked (see service.go's
// getState) means the browser never receives the bytes until that's true.

type secretCopy struct {
	stamp string
	// per-lang name/desc, base64-encoded exactly as secrets.js stores them.
	langs map[string][2]string // lang -> {name, desc}
}

// secretsTable is generated verbatim from lib/achievements/secrets.js's
// SECRETS object (a one-off transcription — see secrets_test.go, which
// re-decodes the whole table and asserts every string is valid UTF-8 and
// non-empty). Keep in sync with the Node source by hand.
var secretsTable = map[string]secretCopy{
	"secret_leap_day": {stamp: "leaf", langs: map[string][2]string{
		"de": {"U2NoYWx0amFocmVza2luZA==", "RWluIEJlenVnIGFuIGVpbmVtIDI5LiBGZWJydWFyLg=="},
		"en": {"TGVhcCBDaGlsZA==", "QSBzaG90IHB1bGxlZCBvbiBGZWJydWFyeSAyOXRoLg=="},
		"it": {"QmFtYmlubyBiaXNlc3RpbGU=", "VW4nZXN0cmF6aW9uZSBpbCAyOSBmZWJicmFpby4="},
		"fr": {"RW5mYW50IGJpc3NleHRpbGU=", "VW5lIGV4dHJhY3Rpb24gbGUgMjkgZsOpdnJpZXIu"},
		"es": {"TmnDsW8gYmlzaWVzdG8=", "VW5hIGV4dHJhY2Npw7NuIGVsIDI5IGRlIGZlYnJlcm8u"},
		"nl": {"U2Nocmlra2Vsa2luZA==", "RWVuIHNob3QgZ2V0cm9ra2VuIG9wIDI5IGZlYnJ1YXJpLg=="},
	}},
	"secret_friday_13": {stamp: "moon", langs: map[string][2]string{
		"de": {"VW5nbMO8Y2tzYnJpbmdlcg==", "RWluIEJlenVnIGFuIGVpbmVtIEZyZWl0YWcsIGRlbSAxMy4="},
		"en": {"QmFkIEx1Y2sgQ2hhcm0=", "QSBzaG90IHB1bGxlZCBvbiBGcmlkYXkgdGhlIDEzdGgu"},
		"it": {"UG9ydGFzZm9ydHVuYQ==", "VW4nZXN0cmF6aW9uZSBkaSB2ZW5lcmTDrCAxMy4="},
		"fr": {"UG9ydGUtbWFsaGV1cg==", "VW5lIGV4dHJhY3Rpb24gdW4gdmVuZHJlZGkgMTMu"},
		"es": {"QW11bGV0byBkZSBtYWxhIHN1ZXJ0ZQ==", "VW5hIGV4dHJhY2Npw7NuIGVuIHZpZXJuZXMgMTMu"},
		"nl": {"T25nZWx1a3NicmVuZ2Vy", "RWVuIHNob3QgZ2V0cm9ra2VuIG9wIHZyaWpkYWcgZGUgMTNlLg=="},
	}},
	"secret_witching_hour": {stamp: "clock", langs: map[string][2]string{
		"de": {"R2Vpc3RlcnN0dW5kZQ==", "RWluIEJlenVnIGdlbmF1IHVtIDM6MzMgVWhyLg=="},
		"en": {"V2l0Y2hpbmcgSG91cg==", "QSBzaG90IHB1bGxlZCBhdCBleGFjdGx5IDM6MzMgYW0u"},
		"it": {"T3JhIGRlbGxlIHN0cmVnaGU=", "VW4nZXN0cmF6aW9uZSBlc2F0dGFtZW50ZSBhbGxlIDM6MzMu"},
		"fr": {"SGV1cmUgZGVzIHNvcmNpw6hyZXM=", "VW5lIGV4dHJhY3Rpb24gw6AgM2gzMyBwcsOpY2lzZXMu"},
		"es": {"SG9yYSBicnVqYQ==", "VW5hIGV4dHJhY2Npw7NuIGV4YWN0YW1lbnRlIGEgbGFzIDM6MzMu"},
		"nl": {"U3Bvb2t1dXI=", "RWVuIHNob3QgZ2V0cm9ra2VuIG9tIHByZWNpZXMgMzozMyB1dXIu"},
	}},
	"secret_new_year": {stamp: "star", langs: map[string][2]string{
		"de": {"TmV1amFocnNzY2hsdWNr", "RGVyIGVyc3RlIEJlenVnIGRlcyBKYWhyZXMsIGluIGRlciBhbGxlcmVyc3RlbiBNaW51dGUu"},
		"en": {"TmV3IFllYXIncyBTaXA=", "VGhlIHllYXIncyBmaXJzdCBzaG90LCBwdWxsZWQgd2l0aGluIGl0cyB2ZXJ5IGZpcnN0IG1pbnV0ZS4="},
		"it": {"U29yc28gZGkgQ2Fwb2Rhbm5v", "SWwgcHJpbW8gY2FmZsOoIGRlbGwnYW5ubywgbmVsIHByaW1pc3NpbW8gbWludXRvLg=="},
		"fr": {"R29yZ8OpZSBkdSBOb3V2ZWwgQW4=", "TGUgcHJlbWllciBjYWbDqSBkZSBsJ2FubsOpZSwgZGFucyBzYSB0b3V0ZSBwcmVtacOocmUgbWludXRlLg=="},
		"es": {"U29yYm8gZGUgQcOxbyBOdWV2bw==", "RWwgcHJpbWVyIGNhZsOpIGRlbCBhw7FvLCBlbiBzdSBwcmltZXIgbWludXRvLg=="},
		"nl": {"TmlldXdqYWFyc3Nsb2s=", "RGUgZWVyc3RlIHNob3QgdmFuIGhldCBqYWFyLCBiaW5uZW4gZGUgYWxsZXJlZXJzdGUgbWludXV0Lg=="},
	}},
	"secret_palindrome_id": {stamp: "target", langs: map[string][2]string{
		"de": {"U3BpZWdlbGJpbGQ=", "RWluZSBCZXp1Z3NudW1tZXIsIGRpZSB2b3J3w6RydHMgd2llIHLDvGNrd8OkcnRzIGdlbGVzZW4gZ2xlaWNoIGJsZWlidC4="},
		"en": {"TWlycm9yIEltYWdl", "QSBzaG90IG51bWJlciB0aGF0IHJlYWRzIHRoZSBzYW1lIGZvcndhcmRzIGFuZCBiYWNrd2FyZHMu"},
		"it": {"SW1tYWdpbmUgc3BlY3VsYXJl", "VW4gbnVtZXJvIGRpIGVzdHJhemlvbmUgY2hlIHNpIGxlZ2dlIHVndWFsZSBpbiBlbnRyYW1iaSBpIHNlbnNpLg=="},
		"fr": {"SW1hZ2UgbWlyb2ly", "VW4gbnVtw6lybyBkJ2V4dHJhY3Rpb24gcXVpIHNlIGxpdCBwYXJlaWwgZGFucyBsZXMgZGV1eCBzZW5zLg=="},
		"es": {"SW1hZ2VuIGVzcGVjdWxhcg==", "VW4gbsO6bWVybyBkZSBleHRyYWNjacOzbiBxdWUgc2UgbGVlIGlndWFsIGVuIGFtYm9zIHNlbnRpZG9zLg=="},
		"nl": {"U3BpZWdlbGJlZWxk", "RWVuIHNob3RudW1tZXIgZGF0IHZvb3ItIGVuIGFjaHRlcnN0ZXZvcmVuIGhldHplbGZkZSBpcy4="},
	}},
	"secret_golden_shot": {stamp: "drop", langs: map[string][2]string{
		"de": {"R29sZGVuZXIgU2Nobml0dA==", "RWluIFZlcmjDpGx0bmlzIHZvbiBFaW53YWFnZSB6dSBBdXN3YWFnZSBnZW5hdSBhbSBHb2xkZW5lbiBTY2huaXR0IOKAlCAxOjEsNjE4Lg=="},
		"en": {"R29sZGVuIFJhdGlv", "QSBkb3NlLXRvLXlpZWxkIHJhdGlvIGxhbmRpbmcgZXhhY3RseSBvbiB0aGUgR29sZGVuIFJhdGlvIOKAlCAxOjEuNjE4Lg=="},
		"it": {"U2V6aW9uZSBhdXJlYQ==", "VW4gcmFwcG9ydG8gZG9zZS9yZXNhIGVzYXR0YW1lbnRlIHN1bGxhIHNlemlvbmUgYXVyZWEg4oCUIDE6MSw2MTgu"},
		"fr": {"Tm9tYnJlIGQnb3I=", "VW4gcmF0aW8gZG9zZS9yZW5kZW1lbnQgdG9tYmFudCBleGFjdGVtZW50IHN1ciBsZSBub21icmUgZCdvciDigJQgMToxLDYxOC4="},
		"es": {"UHJvcG9yY2nDs24gw6F1cmVh", "VW5hIHByb3BvcmNpw7NuIGRlIGRvc2lzIGEgcmVuZGltaWVudG8gZXhhY3RhbWVudGUgZW4gbGEgcHJvcG9yY2nDs24gw6F1cmVhIOKAlCAxOjEsNjE4Lg=="},
		"nl": {"R3VsZGVuIHNuZWRl", "RWVuIGRvc2lzLXRvdC15aWVsZC12ZXJob3VkaW5nIGRpZSBwcmVjaWVzIG9wIGRlIGd1bGRlbiBzbmVkZSB1aXRrb210IOKAlCAxOjEsNjE4Lg=="},
	}},
}

const secretFallbackLang = "en"

// SecretCopy is the decoded { stamp, name, description } getSecretCopy
// returns.
type SecretCopy struct {
	Stamp       string
	Name        string
	Description string
}

// getSecretCopy ports secrets.js's getSecretCopy(id, lang): decoded name/
// description in the given language, English fallback for an
// unrecognised/missing lang. ok=false when id isn't a known secret.
func getSecretCopy(id, lang string) (SecretCopy, bool) {
	entry, ok := secretsTable[id]
	if !ok {
		return SecretCopy{}, false
	}
	pair, ok := entry.langs[lang]
	if !ok {
		pair = entry.langs[secretFallbackLang]
	}
	return SecretCopy{
		Stamp:       entry.stamp,
		Name:        decodeB64(pair[0]),
		Description: decodeB64(pair[1]),
	}, true
}

func decodeB64(s string) string {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	return string(b)
}

// secretIDs mirrors secrets.js's SECRET_IDS (Object.keys order isn't
// load-bearing — nothing iterates it in a fixed order).
func secretIDs() map[string]bool {
	out := make(map[string]bool, len(secretsTable))
	for id := range secretsTable {
		out[id] = true
	}
	return out
}
