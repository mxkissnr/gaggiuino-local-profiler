package mcp

import (
	"context"
	"strings"
	"testing"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func promptText(t *testing.T, session *mcpsdk.ClientSession, name string, args map[string]string) string {
	t.Helper()
	res, err := session.GetPrompt(context.Background(), &mcpsdk.GetPromptParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("GetPrompt %s: %v", name, err)
	}
	var b strings.Builder
	for _, m := range res.Messages {
		if tc, ok := m.Content.(*mcpsdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	if b.Len() == 0 {
		t.Fatalf("prompt %s produced no text", name)
	}
	return b.String()
}

// TestPromptList checks both prompts are advertised, in the SDK's name-sorted
// order, each with exactly one required argument.
func TestPromptList(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, false)
	session := connect(t, ts.URL+Path)

	res, err := session.ListPrompts(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListPrompts: %v", err)
	}
	names := make([]string, 0, len(res.Prompts))
	args := make(map[string]string, len(res.Prompts))
	for _, p := range res.Prompts {
		names = append(names, p.Name)
		if len(p.Arguments) != 1 {
			t.Fatalf("prompt %s has %d arguments, want 1", p.Name, len(p.Arguments))
		}
		a := p.Arguments[0]
		if !a.Required {
			t.Fatalf("prompt %s argument %q is not required", p.Name, a.Name)
		}
		args[p.Name] = a.Name
	}
	// The SDK sorts prompts by name.
	if got, want := strings.Join(names, ","), "analyse_shot,dial_in_bean"; got != want {
		t.Fatalf("prompt list = %q, want %q", got, want)
	}
	if got := args["dial_in_bean"]; got != "bean" {
		t.Fatalf("dial_in_bean argument = %q, want %q", got, "bean")
	}
	if got := args["analyse_shot"]; got != "shot_id" {
		t.Fatalf("analyse_shot argument = %q, want %q", got, "shot_id")
	}
}

// TestDialInBeanPromptReadOnly checks the message renders the argument and
// names the read tools, and that it does not offer write tools when they are
// not registered.
func TestDialInBeanPromptReadOnly(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, false)
	session := connect(t, ts.URL+Path)

	text := promptText(t, session, "dial_in_bean", map[string]string{"bean": "Kieni AA"})
	for _, want := range []string{"Kieni AA", "list_beans", "list_shots", "get_shot", "include_curve"} {
		if !strings.Contains(text, want) {
			t.Fatalf("dial_in_bean message missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "annotate_shot") || strings.Contains(text, "set_known_grind") {
		t.Fatalf("dial_in_bean offers write tools without the opt-in:\n%s", text)
	}
}

// TestDialInBeanPromptOffersWriteWithOptIn checks the write sentence appears
// only when AllowWrite is set.
func TestDialInBeanPromptOffersWriteWithOptIn(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, true)
	session := connect(t, ts.URL+Path)

	text := promptText(t, session, "dial_in_bean", map[string]string{"bean": "Kieni AA"})
	if !strings.Contains(text, "annotate_shot") || !strings.Contains(text, "set_known_grind") {
		t.Fatalf("dial_in_bean does not offer the write tools with the opt-in:\n%s", text)
	}
}

// TestDialInBeanTextGatesWriteOffer exercises the pure builder directly.
func TestDialInBeanTextGatesWriteOffer(t *testing.T) {
	if strings.Contains(dialInBeanText("Bean", false), "annotate_shot") {
		t.Fatalf("read-only dial_in_bean text should not mention annotate_shot")
	}
	if !strings.Contains(dialInBeanText("Bean", true), "annotate_shot") {
		t.Fatalf("write-enabled dial_in_bean text should mention annotate_shot")
	}
}

// TestAnalyseShotPrompt checks the message renders the shot id and names the
// read tools it wants the assistant to use.
func TestAnalyseShotPrompt(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, false)
	session := connect(t, ts.URL+Path)

	text := promptText(t, session, "analyse_shot", map[string]string{"shot_id": "42"})
	for _, want := range []string{"42", "get_shot", "include_curve", "compare_shots"} {
		if !strings.Contains(text, want) {
			t.Fatalf("analyse_shot message missing %q:\n%s", want, text)
		}
	}
}

// TestPromptMissingArgumentIsError checks a missing or blank required argument
// comes back as a protocol error.
func TestPromptMissingArgumentIsError(t *testing.T) {
	ts, _, _, _, _ := newWriteServer(t, false)
	session := connect(t, ts.URL+Path)

	cases := []struct {
		name string
		args map[string]string
	}{
		{"analyse_shot", nil},
		{"analyse_shot", map[string]string{"shot_id": "   "}},
		{"dial_in_bean", nil},
		{"dial_in_bean", map[string]string{"bean": ""}},
	}
	for _, c := range cases {
		if _, err := session.GetPrompt(context.Background(), &mcpsdk.GetPromptParams{Name: c.name, Arguments: c.args}); err == nil {
			t.Fatalf("GetPrompt(%s, %v) = nil error, want error", c.name, c.args)
		}
	}
}
