package mcp

import (
	"context"
	"fmt"
	"strings"

	mcpsdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Prompts are lightweight, read-only starting points the user can invoke from
// their MCP client; unlike tools they run no code, they just hand the
// assistant a user message naming the tools to call. Both are registered
// regardless of the write setting, because even a read-only client benefits
// from the guidance. The only write-aware part is the optional closing offer
// to record the outcome, which is added solely when the write tools exist.

const (
	dialInBeanPromptName  = "dial_in_bean"
	analyseShotPromptName = "analyse_shot"
)

// registerPrompts adds the two guided prompts to the server. allowWrite only
// decides whether the dial-in message offers to persist the result.
func registerPrompts(srv *mcpsdk.Server, allowWrite bool) {
	srv.AddPrompt(&mcpsdk.Prompt{
		Name:        dialInBeanPromptName,
		Title:       "Dial in a bean",
		Description: "Find one bean's recent shots, compare the best and worst, and propose a single concrete change.",
		Arguments: []*mcpsdk.PromptArgument{{
			Name:        "bean",
			Title:       "Bean",
			Description: "The bean's name or id.",
			Required:    true,
		}},
	}, func(_ context.Context, req *mcpsdk.GetPromptRequest) (*mcpsdk.GetPromptResult, error) {
		bean, err := requiredPromptArg(req, "bean")
		if err != nil {
			return nil, err
		}
		return userPrompt(dialInBeanText(bean, allowWrite)), nil
	})

	srv.AddPrompt(&mcpsdk.Prompt{
		Name:        analyseShotPromptName,
		Title:       "Analyse a shot",
		Description: "Review one shot against the two previous shots of the same bean and explain what happened.",
		Arguments: []*mcpsdk.PromptArgument{{
			Name:        "shot_id",
			Title:       "Shot id",
			Description: "The id of the shot to analyse; use list_shots to find ids.",
			Required:    true,
		}},
	}, func(_ context.Context, req *mcpsdk.GetPromptRequest) (*mcpsdk.GetPromptResult, error) {
		shotID, err := requiredPromptArg(req, "shot_id")
		if err != nil {
			return nil, err
		}
		return userPrompt(analyseShotText(shotID)), nil
	})
}

// dialInBeanText builds the user message for dial_in_bean. The write sentence
// is only appended when the server exposes the write tools, so the suggested
// next step is always callable.
func dialInBeanText(bean string, allowWrite bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Help me dial in the bean %q. ", bean)
	b.WriteString("Call list_beans to find it, then list_shots filtered to that bean. ")
	b.WriteString("Call get_shot with include_curve on the best- and worst-rated recent shots, ")
	b.WriteString("then propose ONE concrete change (grind, dose, ratio or temperature) and explain the reason.")
	if allowWrite {
		b.WriteString(" Offer to record the result with annotate_shot or set_known_grind.")
	}
	return b.String()
}

// analyseShotText builds the user message for analyse_shot.
func analyseShotText(shotID string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Analyse shot %q. ", shotID)
	b.WriteString("Call get_shot with include_curve to see its metrics and curve, ")
	b.WriteString("then compare_shots against the two previous shots of the same bean. ")
	b.WriteString("Explain in plain language what went right or wrong: channeling, pressure/flow shape, ratio and time.")
	return b.String()
}

// requiredPromptArg reads a required prompt argument, trimming whitespace, and
// reports a missing or blank value as an error (which the SDK turns into a
// protocol error).
func requiredPromptArg(req *mcpsdk.GetPromptRequest, name string) (string, error) {
	if req != nil && req.Params != nil {
		if v := strings.TrimSpace(req.Params.Arguments[name]); v != "" {
			return v, nil
		}
	}
	return "", fmt.Errorf("prompt argument %q is required", name)
}

// userPrompt wraps one user message as a prompt result.
func userPrompt(text string) *mcpsdk.GetPromptResult {
	return &mcpsdk.GetPromptResult{
		Messages: []*mcpsdk.PromptMessage{{
			Role:    "user",
			Content: &mcpsdk.TextContent{Text: text},
		}},
	}
}
