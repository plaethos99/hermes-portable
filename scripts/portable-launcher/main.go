package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

// @lat: [[main-process#Portable launcher]]
func main() {
	exe, err := os.Executable()
	if err != nil {
		fail("Could not find this program's folder.")
	}
	root, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		fail("Could not resolve the portable folder.")
	}
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}

	runtime := filepath.Join(root, "runtime")
	scratch := filepath.Join(runtime, "scratch")
	hermesHome := filepath.Join(runtime, "hermes")
	userData := filepath.Join(runtime, "electron")
	pythonHome := filepath.Join(runtime, "python")
	packaged := filepath.Join(root, "app", "hermes-agent.exe")
	devElectron := filepath.Join(root, "node_modules", "electron", "dist", "electron.exe")

	for _, dir := range []string{
		scratch,
		hermesHome,
		userData,
		filepath.Join(runtime, "crashes"),
		filepath.Join(runtime, "cache", "pyc"),
		filepath.Join(runtime, "cache", "pip"),
		filepath.Join(runtime, "cache", "uv"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			fail("Could not create " + dir)
		}
	}

	var command *exec.Cmd
	if _, err := os.Stat(packaged); err == nil {
		command = exec.Command(packaged, "--user-data-dir="+userData)
	} else if _, err := os.Stat(devElectron); err == nil {
		if _, err := os.Stat(filepath.Join(root, "out", "main", "index.js")); err != nil {
			fail("The app UI is not built yet.\nMissing out\\main\\index.js")
		}
		command = exec.Command(devElectron, root, "--user-data-dir="+userData)
	} else {
		fail("Hermes.exe must stay next to the app folder.\nMissing " + packaged)
	}
	ensureDefaultEnv(hermesHome)
	writePyvenv(pythonHome, hermesHome)
	if _, err := os.Stat(packaged); err == nil {
		command.Dir = filepath.Dir(packaged)
	} else {
		command.Dir = root
	}
	command.Env = withOverrides(sandboxedEnviron(), map[string]string{
		"HERMES_PORTABLE":               "1",
		"HERMES_PORTABLE_ROOT":          root,
		"HERMES_HOME":                   hermesHome,
		"HERMES_DESKTOP_USER_DATA_DIR":  userData,
		"TEMP":                          scratch,
		"TMP":                           scratch,
		"TMPDIR":                        scratch,
		"PYTHONNOUSERSITE":              "1",
		"PYTHONPYCACHEPREFIX":           filepath.Join(runtime, "cache", "pyc"),
		"PIP_CACHE_DIR":                 filepath.Join(runtime, "cache", "pip"),
		"UV_CACHE_DIR":                  filepath.Join(runtime, "cache", "uv"),
		"ELECTRON_CACHE":                filepath.Join(runtime, "cache", "electron"),
		"ELECTRON_BUILDER_CACHE":        filepath.Join(runtime, "cache", "electron-builder"),
		"HERMES_DISABLE_LAZY_INSTALLS":  "1",
		"HERMES_NO_AUTO_UPDATE":         "1",
		"UV_OFFLINE":                    "1",
		"PIP_NO_INDEX":                  "1",
		"PATH":                          joinPath(append(storePath(hermesHome), splitPath(filterPath(os.Getenv("PATH")))...)),
	})
	if err := command.Run(); err != nil {
		fail("Hermes failed to start.\n" + err.Error())
	}
}

func ensureDefaultEnv(hermesHome string) {
	envFile := filepath.Join(hermesHome, ".env")
	if _, err := os.Stat(envFile); err == nil {
		return
	}
	var b [16]byte
	_, _ = rand.Read(b[:])
	key := fmt.Sprintf("desk-%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	content := fmt.Sprintf("# Generated portable session secret\r\nAPI_SERVER_KEY=%s\r\n", key)
	_ = os.WriteFile(envFile, []byte(content), 0o600)
}

func writePyvenv(pythonHome, hermesHome string) {
	pythonExe := filepath.Join(pythonHome, "python.exe")
	venv := filepath.Join(hermesHome, "hermes-agent", "venv")
	if _, err := os.Stat(pythonExe); err != nil {
		return
	}
	if _, err := os.Stat(venv); err != nil {
		return
	}
	body := fmt.Sprintf(
		"home = %s\r\ninclude-system-site-packages = false\r\nexecutable = %s\r\n",
		pythonHome,
		pythonExe,
	)
	_ = os.WriteFile(filepath.Join(venv, "pyvenv.cfg"), []byte(body), 0o644)
}

// storePath returns the bundled tool folders (ffmpeg, node, ripgrep, ...) that
// PM recorded in tools\facts.json. Installed agents get these from a shell
// activation step; the portable folder has none, so the launcher prepends them
// after filterPath, which would otherwise drop them for containing "hermes".
func storePath(hermesHome string) []string {
	store := filepath.Join(hermesHome, "tools")
	raw, err := os.ReadFile(filepath.Join(store, "facts.json"))
	if err != nil {
		return nil
	}
	var facts struct {
		Packages map[string]struct {
			Env map[string]json.RawMessage `json:"env"`
		} `json:"packages"`
	}
	if json.Unmarshal(raw, &facts) != nil {
		return nil
	}
	names := make([]string, 0, len(facts.Packages))
	for name := range facts.Packages {
		names = append(names, name)
	}
	sort.Strings(names)
	var dirs []string
	for _, name := range names {
		value, ok := facts.Packages[name].Env["PATH"]
		if !ok {
			continue
		}
		var list []string
		if json.Unmarshal(value, &list) != nil {
			var one string
			if json.Unmarshal(value, &one) != nil {
				continue
			}
			list = []string{one}
		}
		for _, dir := range list {
			dir = filepath.Clean(strings.ReplaceAll(dir, "{{store}}", store))
			if info, err := os.Stat(dir); err == nil && info.IsDir() {
				dirs = append(dirs, dir)
			}
		}
	}
	return dirs
}

// sandboxedEnviron drops credentials and agent locations inherited from the
// machine so this folder cannot attach to another Hermes or ERP install.
func sandboxedEnviron() []string {
	var out []string
	for _, entry := range os.Environ() {
		key := entry
		if i := indexByte(entry, '='); i >= 0 {
			key = entry[:i]
		}
		name := fold(key)
		if droppedEnv(name) {
			continue
		}
		if name == "PATH" || name == "PATHEXT" {
			if i := indexByte(entry, '='); i >= 0 && name == "PATH" {
				entry = key + "=" + filterPath(entry[i+1:])
			}
		}
		out = append(out, entry)
	}
	return out
}

func droppedEnv(name string) bool {
	switch name {
	case "PYTHONPATH", "VIRTUAL_ENV", "PYTHONUSERBASE", "PYTHONSTARTUP", "PIP_USER", "API_SERVER_KEY":
		return true
	}
	if len(name) >= 7 && name[:7] == "HERMES_" {
		return true
	}
	if len(name) >= 4 && name[:4] == "ERP_" {
		return true
	}
	if len(name) >= 8 && name[len(name)-8:] == "_API_KEY" {
		return true
	}
	if len(name) >= 6 && name[len(name)-6:] == "_TOKEN" {
		return true
	}
	return false
}

func filterPath(value string) string {
	parts := splitPath(value)
	kept := make([]string, 0, len(parts))
	for _, part := range parts {
		folded := fold(part)
		if contains(folded, "HERMES") || contains(folded, "ERP-AGENT") {
			continue
		}
		kept = append(kept, part)
	}
	return joinPath(kept)
}

func splitPath(value string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(value); i++ {
		if value[i] == ';' {
			if i > start {
				parts = append(parts, value[start:i])
			}
			start = i + 1
		}
	}
	if start < len(value) {
		parts = append(parts, value[start:])
	}
	return parts
}

func joinPath(parts []string) string {
	out := ""
	for i, part := range parts {
		if i > 0 {
			out += ";"
		}
		out += part
	}
	return out
}

func contains(value, needle string) bool {
	if len(needle) == 0 || len(value) < len(needle) {
		return false
	}
	for i := 0; i+len(needle) <= len(value); i++ {
		if value[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func withOverrides(base []string, values map[string]string) []string {
	folded := map[string]string{}
	for key, value := range values {
		folded[fold(key)] = value
	}
	out := make([]string, 0, len(base)+len(values))
	for _, entry := range base {
		key := entry
		if i := indexByte(entry, '='); i >= 0 {
			key = entry[:i]
		}
		if _, ok := folded[fold(key)]; ok {
			continue
		}
		out = append(out, entry)
	}
	for key, value := range folded {
		out = append(out, key+"="+value)
	}
	return out
}

func fold(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - ('a' - 'A')
		}
	}
	return string(b)
}

func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

func fail(text string) {
	messageBox("Hermes", text)
	os.Exit(1)
}

func messageBox(title, text string) {
	user32 := syscall.NewLazyDLL("user32.dll")
	proc := user32.NewProc("MessageBoxW")
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	textPtr, _ := syscall.UTF16PtrFromString(text)
	const mbIconError = 0x10
	_, _, _ = proc.Call(0, uintptr(unsafe.Pointer(textPtr)), uintptr(unsafe.Pointer(titlePtr)), mbIconError)
}
