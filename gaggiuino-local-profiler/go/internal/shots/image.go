package shots

import "github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"

// The image helpers this package used to carry (imagePath / deleteImage /
// saveUploadedImage / the content-type whitelist / the magic-byte sniff)
// now live in internal/img, shared with internal/library and
// internal/backup — see that package's doc.go. DefaultImageDir stays
// re-exported here because Handlers takes it as an injectable field and
// tests reference shots.DefaultImageDir.
const DefaultImageDir = img.DefaultImageDir
