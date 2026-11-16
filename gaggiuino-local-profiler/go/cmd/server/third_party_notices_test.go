package main

// #2080: the third-party notices list the Go modules that end up inside the
// server binary, but that list is prose. Nothing else would notice if a Renovate
// bump moved a version, if a new dependency entered the build graph, or if a
// module left it. This guard derives the expected set from the package graph —
// what the image actually compiles — for the three architectures the image
// ships, and compares it with the Server group of the notices file that the
// settings UI shows.

import (
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const (
	noticesFile = "../../../public-src/public/THIRD_PARTY_NOTICES.md"
	dockerfile  = "../../../Dockerfile"
	serverGroup = "## Server"
	standardLib = "Go standard library"
)

// serverNoticeHeadings returns the component headings of the Server group, in
// file order.
func serverNoticeHeadings(notices string) []string {
	var headings []string
	inside := false
	for _, line := range strings.Split(notices, "\n") {
		if line == serverGroup {
			inside = true
			continue
		}
		if !inside {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			break
		}
		if strings.HasPrefix(line, "### ") {
			headings = append(headings, strings.TrimPrefix(line, "### "))
		}
	}
	return headings
}

// serverEntry returns one component entry: its heading line and everything up
// to the next heading.
func serverEntry(notices, heading string) string {
	lines := strings.Split(notices, "\n")
	start := -1
	for i, line := range lines {
		if start >= 0 && strings.HasPrefix(line, "#") {
			return strings.Join(lines[start:i], "\n")
		}
		if line == "### "+heading {
			start = i
		}
	}
	if start < 0 {
		return ""
	}
	return strings.Join(lines[start:], "\n")
}

// linkedServerModules runs the package query the server build relies on for each
// architecture in the image and merges the results into path -> version.
func linkedServerModules(t *testing.T) map[string]string {
	t.Helper()
	const format = "{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}}{{if .Replace}} REPLACED{{end}}{{end}}{{end}}"
	modules := map[string]string{}
	for _, arch := range []string{"amd64", "arm64", "arm"} {
		cmd := exec.Command("go", "list", "-deps", "-f", format, ".")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+arch, "GOARM=7")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("go list -deps for linux/%s failed: %v\n%s", arch, err, out)
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			if fields[len(fields)-1] == "REPLACED" {
				t.Fatalf("%s is a replaced module (linux/%s); a replacement needs a deliberate notice decision", fields[0], arch)
			}
			if len(fields) != 2 {
				t.Fatalf("unexpected go list line for linux/%s: %q", arch, line)
			}
			modules[fields[0]] = fields[1]
		}
	}
	if len(modules) == 0 {
		t.Fatal("go list reported no modules for ./cmd/server; the package graph is empty")
	}
	return modules
}

// builderGoVersion reads the Go version of the Dockerfile's builder stage: that
// toolchain's standard library is what ships in the image.
func builderGoVersion(t *testing.T, docker string) string {
	t.Helper()
	matches := regexp.MustCompile(`golang:(\d+\.\d+\.\d+)-alpine`).FindAllStringSubmatch(docker, -1)
	if len(matches) != 1 {
		t.Fatalf("%s has %d golang:<version>-alpine image tags, want exactly 1", dockerfile, len(matches))
	}
	return matches[0][1]
}

func TestThirdPartyNoticesCoverServerModules(t *testing.T) {
	raw, err := os.ReadFile(noticesFile)
	if err != nil {
		t.Fatalf("read %s: %v", noticesFile, err)
	}
	notices := string(raw)
	dockerRaw, err := os.ReadFile(dockerfile)
	if err != nil {
		t.Fatalf("read %s: %v", dockerfile, err)
	}

	headings := serverNoticeHeadings(notices)
	if len(headings) == 0 {
		t.Fatalf("%s has no %q group with any component entry", noticesFile, serverGroup)
	}
	present := make(map[string]bool, len(headings))
	for _, heading := range headings {
		present[heading] = true
	}

	standardHeading := standardLib + " " + builderGoVersion(t, string(dockerRaw))
	if !present[standardHeading] {
		t.Errorf("missing server entry for the standard library of the builder image; add this heading:\n### %s", standardHeading)
	}

	modules := linkedServerModules(t)
	paths := make([]string, 0, len(modules))
	for path := range modules {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	for _, path := range paths {
		version := modules[path]
		heading := path + " " + version
		if !present[heading] {
			t.Errorf("module compiled into the server with no notice entry; add this heading under %q:\n### %s", serverGroup, heading)
			continue
		}
		link := "- Licence: https://pkg.go.dev/" + path + "@" + version + "?tab=licenses"
		if !strings.Contains(serverEntry(notices, heading), link) {
			t.Errorf("notice entry %q must carry %q, or a version bump leaves the licence link behind", heading, link)
		}
	}

	for _, heading := range headings {
		if heading == standardHeading {
			continue
		}
		if strings.HasPrefix(heading, standardLib+" ") {
			t.Errorf("notice entry %q names the wrong Go version; the builder image ships\n### %s", heading, standardHeading)
			continue
		}
		path, version, ok := strings.Cut(heading, " ")
		if !ok {
			continue
		}
		linked, known := modules[path]
		switch {
		case !known:
			t.Errorf("stale notice entry %q: no package of %q is compiled into the server; remove the heading and the text it owns", heading, path)
		case linked != version:
			t.Errorf("notice entry %q has the wrong version; the server links %s, so the heading must read:\n### %s %s", heading, linked, path, linked)
		}
	}
}
