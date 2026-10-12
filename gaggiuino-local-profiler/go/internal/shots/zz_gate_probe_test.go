package shots

import "testing"

// Temporary probe for #1595: must turn the Go gate red. Reverted before merge.
func TestGateProbe1595(t *testing.T) { t.Fatal("deliberate failure: the Go gate must go red") }
