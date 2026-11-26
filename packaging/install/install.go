// Standalone bootstrap. Build or run this file only after authenticating it.
package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
)

var stable = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var commitID = regexp.MustCompile(`^[0-9a-f]{40}$`)
var digest = regexp.MustCompile(`^[0-9a-f]{64}$`)

type manifest struct {
	Schema                          int
	Version, Target, Commit, SHA256 string
	PublicKey                       string `json:"public_key"`
	Files                           map[string]string
}

func hash(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }

func authenticated(raw, sig []byte, pin, version, target string) (manifest, error) {
	var m manifest
	key, err := hex.DecodeString(pin)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, raw, sig) {
		return m, errors.New("manifest signature check failed")
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, err
	}
	if m.Schema != 1 || m.Version != version || m.Target != target || !commitID.MatchString(m.Commit) || !digest.MatchString(m.PublicKey) || !digest.MatchString(m.SHA256) {
		return m, errors.New("incorrect release metadata")
	}
	for _, name := range []string{"wg", "skills/work-graph/SKILL.md", "orca-plugin/orca-plugin.json"} {
		if m.Files[name] == "" {
			return m, fmt.Errorf("missing %s", name)
		}
	}
	for name, sum := range m.Files {
		if !(name == "wg" || strings.HasPrefix(name, "skills/work-graph/") || strings.HasPrefix(name, "orca-plugin/")) || filepath.Clean(name) != name || strings.ContainsAny(name, "\\\x00") || !digest.MatchString(sum) {
			return m, fmt.Errorf("invalid manifest entry %q", name)
		}
	}
	return m, nil
}

func extract(stage string, data []byte, m manifest) error {
	if hash(data) != m.SHA256 {
		return errors.New("archive checksum mismatch")
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	seen := map[string]bool{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		sum, ok := m.Files[h.Name]
		if !ok || seen[h.Name] || h.Typeflag != tar.TypeReg || (h.Mode != 0644 && h.Mode != 0755) || (h.Name == "wg" && h.Mode != 0755) {
			return fmt.Errorf("unexpected archive member %q or mode", h.Name)
		}
		seen[h.Name] = true
		path := filepath.Join(stage, h.Name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(h.Mode))
		if err != nil {
			return err
		}
		d := sha256.New()
		_, err = io.Copy(io.MultiWriter(f, d), tr)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if hex.EncodeToString(d.Sum(nil)) != sum {
			return fmt.Errorf("checksum mismatch for %s", h.Name)
		}
	}
	if len(seen) != len(m.Files) {
		return errors.New("incomplete archive")
	}
	return nil
}

// Each installed generation contains the original signed metadata. Refuse
// activation over local changes, including additions to either resource tree.
func inspect(dir, version, target string) (manifest, error) {
	var m manifest
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || info.Mode().IsRegular() {
			return nil
		}
		return fmt.Errorf("unexpected installed file %s", path)
	})
	if err != nil {
		return m, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return m, err
	}
	sig, err := os.ReadFile(filepath.Join(dir, "manifest.sig"))
	if err != nil {
		return m, err
	}
	pin, err := os.ReadFile(filepath.Join(dir, "signer"))
	if err != nil {
		return m, err
	}
	m, err = authenticated(raw, sig, string(pin), version, target)
	if err != nil {
		return m, err
	}
	seen := 0
	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		name, _ := filepath.Rel(dir, path)
		if name == "manifest.json" || name == "manifest.sig" || name == "signer" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if hash(data) != m.Files[name] {
			return fmt.Errorf("preserve local change in %s", path)
		}
		seen++
		return nil
	})
	if err == nil && seen != len(m.Files) {
		err = errors.New("installed release is incomplete")
	}
	return m, err
}

func link(path string) (string, error) {
	s, err := os.Readlink(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("preserve unmanaged path %s: %w", path, err)
	}
	return s, nil
}

func activate(scratch, path, target string) error {
	tmp := filepath.Join(scratch, "link")
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func older(a, b string) bool {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i, x := range left {
		y := right[i]
		if len(x) != len(y) {
			return len(x) < len(y)
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func install(home, assets, pin, version, target string, migrate bool) error {
	if !filepath.IsAbs(home) || !stable.MatchString(version) || !digest.MatchString(pin) || assets == "" {
		return errors.New("supply -assets DIR -version MAJOR.MINOR.PATCH -key TRUSTED_HEX")
	}
	root := filepath.Join(home, ".local/share/work-graph")
	versions := filepath.Join(root, "versions")
	bin := filepath.Join(home, ".local/bin")
	launcher := filepath.Join(bin, "wg")
	current := filepath.Join(root, "current")
	// Refuse redirects into a checkout or a package manager's prefix.
	for _, dir := range []string{filepath.Join(home, ".local"), filepath.Dir(root), root, versions, bin} {
		err := os.Mkdir(dir, 0700)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("preserve redirected directory %s", dir)
		}
	}
	lock, err := os.Open(root)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	managed := filepath.Join(current, "wg")
	dest, err := link(launcher)
	if err != nil {
		return err
	}
	if dest != "" && dest != managed {
		resolved, err := filepath.EvalSymlinks(launcher)
		sourceRoot, known := strings.CutSuffix(resolved, "/skills/work-graph/scripts/wg.py")
		_, checkoutErr := os.Stat(filepath.Join(sourceRoot, ".git"))
		if err != nil || !known || checkoutErr != nil {
			return errors.New("preserve package-manager or unknown launcher")
		}
		if !migrate {
			return errors.New("source installation: repeat with -migrate-source to replace its launcher")
		}
	} else if dest == "" {
		if path, err := exec.LookPath("wg"); err == nil {
			return fmt.Errorf("preserve existing wg on PATH: %s", path)
		}
	}
	next := "versions/" + version + "-" + target
	active, err := link(current)
	if err != nil {
		return err
	}
	for _, name := range []string{"current", "previous"} {
		value, err := link(filepath.Join(root, name))
		if err != nil {
			return err
		}
		if value == "" {
			continue
		}
		v := strings.TrimSuffix(strings.TrimPrefix(value, "versions/"), "-"+target)
		if !stable.MatchString(v) || value != "versions/"+v+"-"+target {
			return fmt.Errorf("preserve unmanaged %s", name)
		}
		old, err := inspect(filepath.Join(root, value), v, target)
		if err != nil {
			return err
		}
		if name == "current" && active != next && (!older(v, version) || old.PublicKey != pin) {
			return errors.New("next version must be newer and signed with the current release key")
		}
	}
	prefix := filepath.Join(assets, "wg-v"+version+"-"+target)
	raw, err := os.ReadFile(prefix + ".json")
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(prefix + ".sig")
	if err != nil {
		return err
	}
	m, err := authenticated(raw, sig, pin, version, target)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(prefix + ".tar.gz")
	if err != nil {
		return err
	}
	scratch, err := os.MkdirTemp(root, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	stage := filepath.Join(scratch, "release")
	if err := os.Mkdir(stage, 0700); err != nil {
		return err
	}
	if err := extract(stage, data, m); err != nil {
		return err
	}
	for flag, want := range map[string]string{"--version": "wg " + version + " " + target, "--release-key": m.PublicKey} {
		out, err := exec.Command(filepath.Join(stage, "wg"), flag).Output()
		if err != nil || strings.TrimSpace(string(out)) != want {
			return fmt.Errorf("verified binary failed %s check", flag)
		}
	}
	for name, b := range map[string][]byte{"manifest.json": raw, "manifest.sig": sig, "signer": []byte(pin)} {
		if err := os.WriteFile(filepath.Join(stage, name), b, 0600); err != nil {
			return err
		}
	}
	final := filepath.Join(root, next)
	if _, err := os.Lstat(final); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(stage, final); err != nil {
			return err
		}
	} else {
		existing, err := inspect(final, version, target)
		if err != nil {
			return err
		}
		if existing.SHA256 != m.SHA256 {
			return errors.New("version directory already holds a different release")
		}
	}
	if active != next {
		if active != "" {
			if err := activate(scratch, filepath.Join(root, "previous"), active); err != nil {
				return err
			}
		}
		if err := activate(scratch, current, next); err != nil {
			return err
		}
	}
	if dest == "" {
		return os.Symlink(managed, launcher)
	}
	if dest != managed {
		// Stage on the launcher's filesystem, even when share and bin are separate mounts.
		tmp, err := os.MkdirTemp(bin, ".wg-install-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		return activate(tmp, launcher, managed)
	}
	return nil
}

func main() {
	version := flag.String("version", "", "stable release version")
	assets := flag.String("assets", "", "directory with the three release assets")
	key := flag.String("key", "", "independently authenticated Ed25519 public key (hex)")
	migrate := flag.Bool("migrate-source", false, "replace the documented source launcher")
	flag.Parse()
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	osPart := map[string]string{"darwin": "-apple-darwin", "linux": "-unknown-linux-gnu"}[runtime.GOOS]
	if arch == "" || osPart == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "unsupported host or arguments")
		os.Exit(2)
	}
	if err := install(os.Getenv("HOME"), *assets, *key, *version, arch+osPart, *migrate); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
