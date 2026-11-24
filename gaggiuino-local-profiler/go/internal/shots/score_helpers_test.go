package shots

// CalcShotScoreDetail scores against the bean only, without a time window.
// Test-only helper: production code calls CalcShotScoreTargets (#1504).
func CalcShotScoreDetail(shot Shot, bean *Bean) ScoreDetail {
	return CalcShotScoreTargets(shot, ScoreTargets{Bean: bean})
}
