package redact

import "regexp"

// The patterns, applied in this order:
//   - credentials: an X-GLP-Token header, a token=/password=/passwd= value or
//     a Bearer token keeps its label and loses its value;
//   - URLs of any scheme (http, https, ws, wss, mqtt, ...) are replaced
//     whole, user:pass@ and path included. A URL stops at whitespace or a
//     quote and leaves trailing punctuation alone, so Go's
//     `Get "http://host/x": ...` keeps its quotes and `ws://host/ws: EOF` its
//     colon;
//   - the address after `dial tcp`/`dial udp` and the name in a DNS error's
//     `lookup <name>: ` / `lookup <name> on ` (Go's net.OpError and
//     net.DNSError, which name the host outside any URL);
//   - any remaining IPv4 literal (with optional port) or bracketed IPv6
//     literal, e.g. `read tcp 172.30.32.1:4567->192.168.1.5:80`.
var (
	credentialPattern = regexp.MustCompile(`(?i)(X-GLP-Token\s*[:=]\s*|(?:token|password|passwd)=|Bearer\s+)([^/\s@&"']+)`)
	urlPattern        = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.\-]*://[^\s"']*[^\s"':,;.)\]]`)
	dialPattern       = regexp.MustCompile(`\b(dial (?:tcp|udp)[46]?) (\[[^\]\s]*\](?::\d+)?|[^\s:]+(?::\d+)?)`)
	lookupPattern     = regexp.MustCompile(`\b(lookup) ([^\s:]+)(: | on )`)
	ipv4Pattern       = regexp.MustCompile(`\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b`)
	ipv6Pattern       = regexp.MustCompile(`\[[0-9A-Fa-f.%]*:[0-9A-Fa-f.%]*:[0-9A-Fa-f:.%]*\](?::\d+)?`)
)

// Redact returns msg with every credential value replaced by "***", every URL
// by "[url]" and every host or IP address by "[host]".
func Redact(msg string) string {
	msg = credentialPattern.ReplaceAllString(msg, "${1}***")
	msg = urlPattern.ReplaceAllString(msg, "[url]")
	msg = dialPattern.ReplaceAllString(msg, "${1} [host]")
	msg = lookupPattern.ReplaceAllString(msg, "${1} [host]${3}")
	msg = ipv6Pattern.ReplaceAllString(msg, "[host]")
	return ipv4Pattern.ReplaceAllString(msg, "[host]")
}
