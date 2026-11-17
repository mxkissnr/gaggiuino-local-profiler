package shots

import (
	"encoding/json"
	"fmt"
)

// #2100: annotations saved before #2025 still hold the beanAgeDays the old
// rule stored — for a shot brewed from a frozen portion that is the plain age
// of the bag, while the shot badge computes the portion's effective age live
// (#1788) and MCP get_shot reports the raw stored annotation. This one-time
// startup pass re-derives every stored age with the same injected rule
// PatchAnnotation uses (see bean_age_source.go), so the stored value, the MCP
// tools and the shot badge agree again.
//
// An age that no longer resolves (the bean left the library, the named frozen
// portion is gone) leaves the stored value untouched: it is the fallback the
// browser shows for a bean it cannot resolve (#1788).
//
// Only the beanAgeDays key is rewritten, in place, so every other key and its
// formatting stays byte-for-byte as stored. Bean age does not feed the shot
// score, so no score-cache invalidation is needed.

// RecomputeStoredBeanAges re-derives the stored beanAgeDays of every
// annotation row with age and returns how many rows it changed. A nil age
// touches nothing.
//
// The whole pass runs under annotationMu (read and write), so no annotation
// save or patch can interleave with it. The caller loads the library before
// calling, keeping the documented lock order — annotationMu first, then the
// library's writeMu.
func (r *Repository) RecomputeStoredBeanAges(age func(ann map[string]any, shotSec int64) (int, bool)) (int, error) {
	if age == nil {
		return 0, nil
	}

	annotationMu.Lock()
	defer annotationMu.Unlock()

	// No trash filter: a trashed shot keeps the right age for its restore. The
	// join gives every row its measurement moment in the same query, so the
	// loop needs no per-shot read.
	rows, err := r.db.Query(`SELECT a.shot_id, a.data, s.timestamp FROM annotations a JOIN shots s ON s.id = a.shot_id`)
	if err != nil {
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}

	type update struct {
		shotID int64
		days   int
	}
	var pending []update
	for rows.Next() {
		var (
			shotID    int64
			raw       string
			timestamp int64
		)
		if err := rows.Scan(&shotID, &raw, &timestamp); err != nil {
			rows.Close()
			return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
		}
		var ann map[string]any
		// A row that cannot be decoded is skipped, not fatal: one damaged
		// annotation must not stop the rest of the pass.
		if err := json.Unmarshal([]byte(raw), &ann); err != nil || ann == nil {
			continue
		}
		if timestamp <= 0 {
			continue
		}
		days, ok := age(ann, timestamp)
		if !ok {
			continue
		}
		if stored, ok := ann["beanAgeDays"].(float64); ok && stored == float64(days) {
			continue
		}
		pending = append(pending, update{shotID: shotID, days: days})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	if err := rows.Close(); err != nil {
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	if len(pending) == 0 {
		return 0, nil
	}

	tx, err := r.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	stmt, err := tx.Prepare(`UPDATE annotations SET data = json_set(data, '$.beanAgeDays', ?) WHERE shot_id = ?`)
	if err != nil {
		tx.Rollback()
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	changed := 0
	for _, u := range pending {
		if _, err := stmt.Exec(u.days, u.shotID); err != nil {
			stmt.Close()
			tx.Rollback()
			return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
		}
		changed++
	}
	if err := stmt.Close(); err != nil {
		tx.Rollback()
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("shots: recomputing stored bean ages: %w", err)
	}
	return changed, nil
}
