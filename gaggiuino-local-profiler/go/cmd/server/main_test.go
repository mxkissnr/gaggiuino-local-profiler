package main

import (
	"os"
	"testing"
)

func TestGetEnvNumber(t *testing.T) {
	const name = "GLP_TEST_RATE_LIMIT_NUMBER"

	t.Run("unset falls back to default", func(t *testing.T) {
		os.Unsetenv(name)
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default)", got)
		}
	})

	t.Run("valid override wins", func(t *testing.T) {
		t.Setenv(name, "1200")
		if got := getEnvNumber(name, 600); got != 1200 {
			t.Errorf("getEnvNumber() = %v, want 1200 (override)", got)
		}
	})

	t.Run("invalid value falls back to default", func(t *testing.T) {
		t.Setenv(name, "not-a-number")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, invalid input)", got)
		}
	})

	t.Run("zero falls back to default, matching JS falsy semantics", func(t *testing.T) {
		t.Setenv(name, "0")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, zero is falsy in JS)", got)
		}
	})

	t.Run("empty string falls back to default", func(t *testing.T) {
		t.Setenv(name, "")
		if got := getEnvNumber(name, 600); got != 600 {
			t.Errorf("getEnvNumber() = %v, want 600 (default, empty string)", got)
		}
	})
}
