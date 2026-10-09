// Package cutoutmodels is the single Go source of truth for the on-device
// sticker cut-out model files (#1404).
//
// The three ONNX models are not in git: they are published once as GitHub
// release assets under Version and pinned by SHA-256. The Dockerfile's `models`
// stage embeds the same names, release URL and hashes at image-build time;
// this package mirrors that pin list so the Go-side build — and, in later
// slices, the frontend manifest — share one definition instead of repeating
// the names and sizes.
//
// It is deliberately data-only and imports nothing: cmd/frontend-build embeds
// these values into the SPA bundle, and importing internal/webapp (which embeds
// the dist/ that build produces) would create a cycle.
package cutoutmodels

// Version is the glp-models release tag the model files are pinned to.
const Version = "models-v1"

// ReleaseBase is the directory every File is downloaded from; File.Name is
// appended to it.
const ReleaseBase = "https://github.com/mxkissnr/glp-models/releases/download/" + Version + "/"

// File is one pinned model asset: its release asset name, its SHA-256 as
// lowercase hex, and its exact size in bytes. The size lets a client size a
// download before the server has sent a byte (Home Assistant's ingress proxy
// strips Content-Length for bodies above ~4 MB).
type File struct {
	Name   string
	SHA256 string
	Size   int64
}

// Files is the pinned model set, in the order the cut-out loads them. The names
// and hashes mirror the Dockerfile's `models` stage; keep the two in sync.
var Files = []File{
	{
		Name:   "isnet-general-use-int8.onnx",
		SHA256: "f1b1c6f7656e532627697afc989d953be1e7ef8f55a718f3611e8c9fd50cdef7",
		Size:   46360717,
	},
	{
		Name:   "slimsam-vision-encoder-q8.onnx",
		SHA256: "cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971",
		Size:   8882165,
	},
	{
		Name:   "slimsam-decoder-q8.onnx",
		SHA256: "cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2",
		Size:   4903810,
	},
}
