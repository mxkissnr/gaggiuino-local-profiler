package machines

import "testing"

func strPtr(s string) *string { return &s }
func i64Ptr(n int64) *int64   { return &n }
func boolPtr(b bool) *bool    { return &b }

func TestEnsureDefaultMachineSeedsOnce(t *testing.T) {
	reg, _ := newTestRegistry(t)
	if err := reg.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	list, err := reg.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines: %v", err)
	}
	if len(list) != 1 || list[0].ID != 1 || !list[0].IsDefault || list[0].Type != "gaggiuino" {
		t.Fatalf("unexpected seeded machine: %+v", list)
	}

	// Calling again must not seed a second row.
	if err := reg.EnsureDefaultMachine(); err != nil {
		t.Fatalf("second EnsureDefaultMachine: %v", err)
	}
	list, _ = reg.ListMachines()
	if len(list) != 1 {
		t.Fatalf("expected exactly 1 machine after a second EnsureDefaultMachine, got %d", len(list))
	}
}

func TestCreateAndGetMachine(t *testing.T) {
	reg, _ := newTestRegistry(t)
	in := MachineInput{Name: strPtr("Kitchen"), Type: strPtr("gaggimate"), Host: strPtr("gaggimate.local")}
	m, err := reg.CreateMachine(in)
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	if m.Name != "Kitchen" || m.Type != "gaggimate" || m.Host != "gaggimate.local" || m.IsDefault {
		t.Fatalf("unexpected machine: %+v", m)
	}

	got, err := reg.GetMachine(m.ID)
	if err != nil {
		t.Fatalf("GetMachine: %v", err)
	}
	if got == nil || got.ID != m.ID {
		t.Fatalf("GetMachine returned %+v, want a machine with id %d", got, m.ID)
	}

	missing, err := reg.GetMachine(999)
	if err != nil {
		t.Fatalf("GetMachine(999): %v", err)
	}
	if missing != nil {
		t.Fatalf("GetMachine(999) = %+v, want nil", missing)
	}
}

func TestUpdateMachinePartial(t *testing.T) {
	reg, _ := newTestRegistry(t)
	m, err := reg.CreateMachine(MachineInput{Name: strPtr("A"), Type: strPtr("gaggiuino"), Host: strPtr("a.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	updated, err := reg.UpdateMachine(m.ID, MachineInput{Name: strPtr("B")}, nil)
	if err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	if updated.Name != "B" || updated.Host != "a.local" {
		t.Fatalf("partial update changed unrelated fields: %+v", updated)
	}

	notFound, err := reg.UpdateMachine(999, MachineInput{Name: strPtr("X")}, nil)
	if err != nil {
		t.Fatalf("UpdateMachine(999): %v", err)
	}
	if notFound != nil {
		t.Fatalf("UpdateMachine(999) = %+v, want nil", notFound)
	}
}

func TestUpdateMachineHostChangeCallback(t *testing.T) {
	reg, _ := newTestRegistry(t)
	m, _ := reg.CreateMachine(MachineInput{Name: strPtr("A"), Type: strPtr("gaggiuino"), Host: strPtr("old.local")})

	var evictedHost string
	calls := 0
	_, err := reg.UpdateMachine(m.ID, MachineInput{Host: strPtr("new.local")}, func(old string) {
		calls++
		evictedHost = old
	})
	if err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	if calls != 1 || evictedHost != "old.local" {
		t.Fatalf("onHostChanged called %d times with %q, want 1 call with \"old.local\"", calls, evictedHost)
	}

	// Updating a field OTHER than host must not fire the callback.
	calls = 0
	_, err = reg.UpdateMachine(m.ID, MachineInput{Name: strPtr("Renamed")}, func(old string) { calls++ })
	if err != nil {
		t.Fatalf("UpdateMachine (name only): %v", err)
	}
	if calls != 0 {
		t.Fatalf("onHostChanged called %d times on a non-host update, want 0", calls)
	}
}

// TestUpdateMachineTypeChangeCallback is the #901 code-review regression
// test: onHostChanged must also fire when only Type changes (e.g.
// "gaggiuino" -> "gaggimate") with Host held constant, so the caller can
// evict a now-stale live session keyed by that host — not just when Host
// itself changes.
func TestUpdateMachineTypeChangeCallback(t *testing.T) {
	reg, _ := newTestRegistry(t)
	m, _ := reg.CreateMachine(MachineInput{Name: strPtr("A"), Type: strPtr("gaggiuino"), Host: strPtr("same.local")})

	var evictedHost string
	calls := 0
	_, err := reg.UpdateMachine(m.ID, MachineInput{Type: strPtr("gaggimate")}, func(old string) {
		calls++
		evictedHost = old
	})
	if err != nil {
		t.Fatalf("UpdateMachine: %v", err)
	}
	if calls != 1 || evictedHost != "same.local" {
		t.Fatalf("onHostChanged called %d times with %q, want 1 call with \"same.local\"", calls, evictedHost)
	}

	// Updating neither Host nor Type must not fire the callback.
	calls = 0
	_, err = reg.UpdateMachine(m.ID, MachineInput{Name: strPtr("Renamed")}, func(old string) { calls++ })
	if err != nil {
		t.Fatalf("UpdateMachine (name only): %v", err)
	}
	if calls != 0 {
		t.Fatalf("onHostChanged called %d times on a name-only update, want 0", calls)
	}
}

func TestDeleteMachineGuards(t *testing.T) {
	reg, _ := newTestRegistry(t)
	if err := reg.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	def, _ := reg.GetDefaultMachine()

	// Cannot delete the default machine.
	_, err := reg.DeleteMachine(def.ID, nil)
	if err == nil {
		t.Fatal("expected an error deleting the default machine, got nil")
	}

	second, err := reg.CreateMachine(MachineInput{Name: strPtr("B"), Type: strPtr("gaggimate"), Host: strPtr("b.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	var evicted string
	ok, err := reg.DeleteMachine(second.ID, func(host string) { evicted = host })
	if err != nil {
		t.Fatalf("DeleteMachine: %v", err)
	}
	if !ok {
		t.Fatal("DeleteMachine returned false for an existing non-default machine")
	}
	if evicted != "b.local" {
		t.Errorf("onHostEvicted got %q, want \"b.local\"", evicted)
	}

	notFound, err := reg.DeleteMachine(999, nil)
	if err != nil {
		t.Fatalf("DeleteMachine(999): %v", err)
	}
	if notFound {
		t.Error("DeleteMachine(999) = true, want false")
	}
}

func TestDeleteMachineCannotDeleteLastRemaining(t *testing.T) {
	reg, _ := newTestRegistry(t)
	// A single non-default machine (via restore-style direct construction:
	// CreateMachine always makes a non-default row, but EnsureDefaultMachine
	// was never called here, so only one row exists and it isn't flagged
	// default — deleteMachine's "last remaining" guard must still catch it).
	m, err := reg.CreateMachine(MachineInput{Name: strPtr("Solo"), Type: strPtr("gaggiuino"), Host: strPtr("solo.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	_, err = reg.DeleteMachine(m.ID, nil)
	if err == nil {
		t.Fatal("expected an error deleting the last remaining machine, got nil")
	}
}

func TestSetDefaultMachine(t *testing.T) {
	reg, _ := newTestRegistry(t)
	if err := reg.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	second, err := reg.CreateMachine(MachineInput{Name: strPtr("B"), Type: strPtr("gaggimate"), Host: strPtr("b.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	updated, err := reg.SetDefaultMachine(second.ID)
	if err != nil {
		t.Fatalf("SetDefaultMachine: %v", err)
	}
	if !updated.IsDefault {
		t.Fatal("SetDefaultMachine did not flag the target machine as default")
	}

	list, _ := reg.ListMachines()
	defaults := 0
	for _, m := range list {
		if m.IsDefault {
			defaults++
		}
	}
	if defaults != 1 {
		t.Fatalf("expected exactly 1 default machine after reassignment, got %d", defaults)
	}

	missing, err := reg.SetDefaultMachine(999)
	if err != nil {
		t.Fatalf("SetDefaultMachine(999): %v", err)
	}
	if missing != nil {
		t.Fatalf("SetDefaultMachine(999) = %+v, want nil", missing)
	}
}

func TestResolveMachine(t *testing.T) {
	reg, _ := newTestRegistry(t)
	if err := reg.EnsureDefaultMachine(); err != nil {
		t.Fatalf("EnsureDefaultMachine: %v", err)
	}
	second, err := reg.CreateMachine(MachineInput{Name: strPtr("B"), Type: strPtr("gaggimate"), Host: strPtr("b.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	// nil machineId -> default machine (seeded on demand).
	resolved, err := reg.ResolveMachine(nil)
	if err != nil {
		t.Fatalf("ResolveMachine(nil): %v", err)
	}
	if !resolved.IsDefault {
		t.Fatalf("ResolveMachine(nil) = %+v, want the default machine", resolved)
	}

	// Explicit, known id -> that machine.
	resolved, err = reg.ResolveMachine(&second.ID)
	if err != nil {
		t.Fatalf("ResolveMachine(second.ID): %v", err)
	}
	if resolved.ID != second.ID {
		t.Fatalf("ResolveMachine(second.ID) = %+v, want id %d", resolved, second.ID)
	}

	// Unknown id -> falls back to the default machine.
	unknown := int64(999)
	resolved, err = reg.ResolveMachine(&unknown)
	if err != nil {
		t.Fatalf("ResolveMachine(999): %v", err)
	}
	if !resolved.IsDefault {
		t.Fatalf("ResolveMachine(999) = %+v, want the default machine (fallback)", resolved)
	}
}

func TestMachineThemeRoundTrip(t *testing.T) {
	reg, _ := newTestRegistry(t)
	theme := &Theme{A: "#123456", B: "#abcdef"}
	m, err := reg.CreateMachine(MachineInput{Name: strPtr("Themed"), Type: strPtr("gaggiuino"), Host: strPtr("t.local"), Theme: theme})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	got, err := reg.GetMachine(m.ID)
	if err != nil {
		t.Fatalf("GetMachine: %v", err)
	}
	if got.Theme == nil || got.Theme.A != "#123456" || got.Theme.B != "#abcdef" {
		t.Fatalf("theme did not round-trip: %+v", got.Theme)
	}
}

// TestRestoreMachines_AllInvalid_LeavesExistingRegistryUntouched (#901 code
// review): a backup whose `machines` section contains only invalid entries
// (every one fails MachineInput.validate) must not wipe the existing
// registry — restoring "nothing usable" must be a no-op, not data loss.
func TestRestoreMachines_AllInvalid_LeavesExistingRegistryUntouched(t *testing.T) {
	reg, _ := newTestRegistry(t)
	seeded, err := reg.CreateMachine(MachineInput{Name: strPtr("Kitchen"), Type: strPtr("gaggimate"), Host: strPtr("gaggimate.local")})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	before, err := reg.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines before restore: %v", err)
	}

	// Every entry here fails validate(true): id<=0, and an empty
	// name/unrecognized type respectively.
	invalid := []Machine{
		{ID: 0, Name: "Broken A", Type: "gaggiuino", Host: "a.local"},
		{ID: 5, Name: "", Type: "gaggiuino", Host: "b.local"},
		{ID: 6, Name: "Broken C", Type: "not-a-real-type", Host: "c.local"},
	}
	restored, err := reg.RestoreMachines(invalid)
	if err != nil {
		t.Fatalf("RestoreMachines: %v", err)
	}
	if restored != 0 {
		t.Fatalf("restored = %d, want 0 (nothing valid to restore)", restored)
	}

	after, err := reg.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines after restore: %v", err)
	}
	if len(after) != len(before) || len(after) != 1 || after[0].ID != seeded.ID || after[0].Host != "gaggimate.local" {
		t.Fatalf("registry changed after an all-invalid restore: before=%+v after=%+v", before, after)
	}
}

// TestRestoreMachines_ValidEntries_ReplacesRegistry documents the intended
// contrast to the all-invalid case above: a restore with at least one valid
// entry still wipes and re-inserts as designed.
func TestRestoreMachines_ValidEntries_ReplacesRegistry(t *testing.T) {
	reg, _ := newTestRegistry(t)
	if _, err := reg.CreateMachine(MachineInput{Name: strPtr("Old"), Type: strPtr("gaggiuino"), Host: strPtr("old.local")}); err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}

	incoming := []Machine{
		{ID: 1, Name: "Restored", Type: "gaggimate", Host: "restored.local", IsDefault: true, Enabled: true},
	}
	restored, err := reg.RestoreMachines(incoming)
	if err != nil {
		t.Fatalf("RestoreMachines: %v", err)
	}
	if restored != 1 {
		t.Fatalf("restored = %d, want 1", restored)
	}

	after, err := reg.ListMachines()
	if err != nil {
		t.Fatalf("ListMachines: %v", err)
	}
	if len(after) != 1 || after[0].Host != "restored.local" {
		t.Fatalf("registry after restore = %+v, want only the restored machine", after)
	}
}
