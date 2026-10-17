package library

import (
	"context"
	"net"
	"net/http"
	"testing"
)

// #1626: the barcode lookup, the bean-image download and the geocoder dial
// through a netguard.GuardedDialer, so the TCP connection goes to the address
// the SSRF check approved instead of a second, independent DNS answer. A
// request straight through each client (no pre-flight check) to a host that
// resolves to loopback must be refused by the dial itself; with a plain
// client it would reach the real resolver instead.

func TestLibraryClientsRefuseAPrivateAddressAtDialTime(t *testing.T) {
	withFakeLookup(t, map[string][]net.IP{"rebind.example": {net.ParseIP("127.0.0.1")}})
	clients := map[string]*http.Client{
		"barcode scan": scanHTTPClient,
		"bean image":   fetchImageClient,
		"geocoder":     NewGeocoder(nil, "test").http,
	}
	for name, client := range clients {
		t.Run(name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://rebind.example/", nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := client.Do(req)
			if err == nil {
				resp.Body.Close()
				t.Fatal("request to a host resolving to loopback succeeded, want it refused at dial time")
			}
			if !isSSRFBlocked(err) {
				t.Fatalf("err = %v, want an SSRF block from the pinned dial", err)
			}
		})
	}
}
