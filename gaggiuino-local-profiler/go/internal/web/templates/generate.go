package templates

// templ generate reads every .templ file in this directory and writes the
// matching _templ.go next to it — see go/README.md's Frontend section for
// the exact command (`make -C go generate`) and why the generated files
// aren't committed.
//go:generate templ generate
