package img

import (
	"bytes"
	"image"
	"image/color"
	"testing"
)

// quadrantColors are the four quadrant colours of orientationFixture:
// top-left, top-right, bottom-left, bottom-right.
var quadrantColors = [4]color.RGBA{
	{220, 30, 30, 255},  // red
	{30, 200, 30, 255},  // green
	{30, 30, 220, 255},  // blue
	{230, 220, 30, 255}, // yellow
}

// orientationFixture is a w×h image split into four solid quadrants.
func orientationFixture(w, h int) *image.RGBA {
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			q := 0
			if x >= w/2 {
				q++
			}
			if y >= h/2 {
				q += 2
			}
			im.SetRGBA(x, y, quadrantColors[q])
		}
	}
	return im
}

// nearestQuadrant returns the index of the quadrant colour closest to c.
func nearestQuadrant(c color.Color) int {
	r, g, b, _ := c.RGBA()
	best, bestD := -1, int64(-1)
	for i, q := range quadrantColors {
		dr := int64(r>>8) - int64(q.R)
		dg := int64(g>>8) - int64(q.G)
		db := int64(b>>8) - int64(q.B)
		if d := dr*dr + dg*dg + db*db; bestD < 0 || d < bestD {
			best, bestD = i, d
		}
	}
	return best
}

// TestOptimize_EveryOrientation1616 pins, for all eight EXIF orientations
// and for a source both above and below MaxEdge, the output dimensions and
// which source quadrant ends up in each displayed corner. It was captured
// before #1616 moved the orientation transform after the downscale, which
// must not change either.
func TestOptimize_EveryOrientation1616(t *testing.T) {
	// want[o] lists, for orientation o, the source quadrant shown at the
	// displayed top-left, top-right, bottom-left and bottom-right.
	want := map[uint16][4]int{
		1: {0, 1, 2, 3},
		2: {1, 0, 3, 2},
		3: {3, 2, 1, 0},
		4: {2, 3, 0, 1},
		5: {0, 2, 1, 3},
		6: {2, 0, 3, 1},
		7: {3, 1, 2, 0},
		8: {1, 3, 0, 2},
	}
	for _, size := range [][2]int{{2400, 1800}, {300, 200}} {
		w, h := size[0], size[1]
		data := map[uint16][]byte{}
		for o := uint16(1); o <= 8; o++ {
			data[o] = jpegWithOrientation(t, orientationFixture(w, h), o)
		}
		for o := uint16(1); o <= 8; o++ {
			res, err := Optimize(data[o], "jpg", ModeUpload)
			if err != nil {
				t.Fatalf("%dx%d o=%d: Optimize: %v", w, h, o, err)
			}
			for _, out := range []struct {
				name string
				b    []byte
				edge int
			}{{"main", res.Main, MaxEdge}, {"thumb", res.Thumb, ThumbEdge}} {
				im, _, err := image.Decode(bytes.NewReader(out.b))
				if err != nil {
					t.Fatalf("%dx%d o=%d %s: decode: %v", w, h, o, out.name, err)
				}
				ow, oh := im.Bounds().Dx(), im.Bounds().Dy()
				sw, sh := w, h
				if o >= 5 {
					sw, sh = h, w
				}
				ew, eh := sw, sh
				if long := max(sw, sh); long > out.edge {
					if sw >= sh {
						ew, eh = out.edge, max(int(float64(sh)*float64(out.edge)/float64(sw)), 1)
					} else {
						ew, eh = max(int(float64(sw)*float64(out.edge)/float64(sh)), 1), out.edge
					}
				}
				if ow != ew || oh != eh {
					t.Errorf("%dx%d o=%d %s: size = %dx%d, want %dx%d", w, h, o, out.name, ow, oh, ew, eh)
				}
				b := im.Bounds()
				corners := [4]image.Point{
					{b.Min.X + ow/4, b.Min.Y + oh/4},
					{b.Min.X + 3*ow/4, b.Min.Y + oh/4},
					{b.Min.X + ow/4, b.Min.Y + 3*oh/4},
					{b.Min.X + 3*ow/4, b.Min.Y + 3*oh/4},
				}
				for i, p := range corners {
					if got := nearestQuadrant(im.At(p.X, p.Y)); got != want[o][i] {
						t.Errorf("%dx%d o=%d %s: corner %d shows quadrant %d, want %d", w, h, o, out.name, i, got, want[o][i])
					}
				}
			}
		}
	}
}

// BenchmarkOptimizeRotatedPhoto measures an upload of a 4000×3000 phone
// photo carrying EXIF orientation 6 (rotate 90° CW), the common portrait
// case (#1616). Run:
//
//	go test ./internal/img -run '^$' -bench BenchmarkOptimizeRotatedPhoto -benchmem
func BenchmarkOptimizeRotatedPhoto(b *testing.B) {
	data := jpegWithOrientation(b, orientationFixture(4000, 3000), 6)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Optimize(data, "jpg", ModeUpload); err != nil {
			b.Fatal(err)
		}
	}
}
