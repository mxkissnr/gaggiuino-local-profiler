package shots

// Reference implementations kept for tests only (#1616): production paths
// reach the same results without hydrating or rescoring the whole history,
// and the equivalence tests compare them against these.

// CalcShotScore is the score-only wrapper of CalcShotScoreDetail.
func CalcShotScore(shot Shot, bean *Bean) *int {
	return CalcShotScoreDetail(shot, bean).Score
}

// ComputeComparativeGrindAdvice computes the advice for shot from allShots —
// every other shot on shot's own machine
// (internal/shots.Repository.FindAllExcludingTrashByMachine), already
// machine-filtered before reaching this function. Each comparable shot is
// scored against its own bean target (one loadBeanLookup snapshot for the
// whole pass), so the ranking matches the bean-aware list and detail scores
// rather than the generic bands. It is the pre-#1616 call path, kept here as
// the reference Service.GetComparativeGrindAdvice must match (it reaches the
// same result without hydrating the whole history).
func ComputeComparativeGrindAdvice(shot Shot, allShots []Shot) *ComparativeGrindAdvice {
	m := newComparativeMatch(shot)
	if m == nil {
		return nil
	}
	lookup := loadBeanLookup()
	var comparable []comparableSibling
	for _, s := range allShots {
		g, ok := m.grindOf(s)
		if !ok {
			continue
		}
		score := CalcShotScore(s, lookup(s))
		if score == nil {
			continue
		}
		comparable = append(comparable, comparableSibling{grind: g, score: *score})
	}
	return m.advice(comparable)
}
