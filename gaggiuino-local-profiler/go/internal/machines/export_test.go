package machines

// Test-only helpers kept out of the production files (#1285).

// set stores f and returns the previous value, so a test can restore it
// via t.Cleanup(func() { v.set(prev) }).
func (g *guardVar[F]) set(f F) F {
	prev := g.get()
	g.p.Store(&f)
	return prev
}

// resetCacheForTests clears the cache — test-only helper.
func (c *FirmwareChecker) resetCacheForTests() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache = make(map[int]firmwareCacheEntry)
}
