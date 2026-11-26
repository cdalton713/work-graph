package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

const skillPath = "skills/work-graph/SKILL.md"

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	check(t, os.MkdirAll(filepath.Dir(path), 0700))
	check(t, os.WriteFile(path, []byte(content), 0600))
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	check(t, err)
	return string(b)
}

func target() string {
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	return arch + map[string]string{"darwin": "-apple-darwin", "linux": "-unknown-linux-gnu"}[runtime.GOOS]
}

func buildInstaller(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "install")
	if out, err := exec.Command("go", "build", "-o", bin, "install.go").CombinedOutput(); err != nil {
		t.Fatalf("build installer: %v: %s", err, out)
	}
	return bin
}

type member struct {
	name, data string
	mode       int64
	kind       byte
}
type bundle struct {
	version, platform, pin string
	members                []member
	files                  map[string]string
	archiveDigest          string
}

func checksum(s string) string { d := sha256.Sum256([]byte(s)); return hex.EncodeToString(d[:]) }
func fixture(version string, key ed25519.PrivateKey) bundle {
	pin := hex.EncodeToString(key.Public().(ed25519.PublicKey))
	script := fmt.Sprintf("#!/bin/sh\ncase $1 in --version) echo 'wg %s %s' ;; --release-key) echo '%s' ;; esac\n", version, target(), pin)
	b := bundle{version: version, platform: target(), pin: pin, files: map[string]string{}, members: []member{
		{"wg", script, 0755, tar.TypeReg}, {skillPath, "skill " + version, 0644, tar.TypeReg}, {"orca-plugin/orca-plugin.json", "{}", 0644, tar.TypeReg},
	}}
	for _, m := range b.members {
		b.files[m.name] = checksum(m.data)
	}
	return b
}

func (b bundle) save(t *testing.T, prefix string, key ed25519.PrivateKey) {
	t.Helper()
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	for _, m := range b.members {
		header := tar.Header{Name: m.name, Mode: m.mode, Typeflag: m.kind, Size: int64(len(m.data))}
		if m.kind != tar.TypeReg {
			header.Size = 0
			if m.kind != tar.TypeDir {
				header.Linkname = "wg"
			}
		}
		check(t, tw.WriteHeader(&header))
		if header.Size > 0 {
			_, err := tw.Write([]byte(m.data))
			check(t, err)
		}
	}
	check(t, tw.Close())
	check(t, gz.Close())
	sum := b.archiveDigest
	if sum == "" {
		sum = checksum(archive.String())
	}
	raw, err := json.Marshal(map[string]any{"schema": 1, "version": b.version, "target": b.platform, "public_key": b.pin, "sha256": sum, "files": b.files, "commit": strings.Repeat("1", 40)})
	check(t, err)
	write(t, prefix+".tar.gz", archive.String())
	write(t, prefix+".json", string(raw))
	write(t, prefix+".sig", string(ed25519.Sign(key, raw)))
}

type installation struct {
	bin, home, assets string
	key               ed25519.PrivateKey
}

func setup(t *testing.T, bin string) installation {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	check(t, err)
	f := installation{bin, t.TempDir(), t.TempDir(), key}
	write(t, f.path(".config/work-graph/config.json"), "user config")
	write(t, f.path(".config/work-graph/link-token"), "user token")
	return f
}
func (f installation) path(name string) string { return filepath.Join(f.home, name) }
func (f installation) prefix(version string) string {
	return filepath.Join(f.assets, "wg-v"+version+"-"+target())
}
func (f installation) release(t *testing.T, v string) {
	t.Helper()
	fixture(v, f.key).save(t, f.prefix(v), f.key)
}
func (f installation) run(t *testing.T, version, reason string, flags ...string) {
	t.Helper()
	args := append([]string{"-version", version, "-assets", f.assets, "-key", hex.EncodeToString(f.key.Public().(ed25519.PublicKey))}, flags...)
	cmd := exec.Command(f.bin, args...)
	cmd.Env = []string{"HOME=" + f.home, "PATH=" + f.path("package/bin")}
	out, err := cmd.CombinedOutput()
	if reason == "" {
		if err != nil {
			t.Fatalf("install %s: %v: %s", version, err, out)
		}
		return
	}
	var status *exec.ExitError
	if !errors.As(err, &status) || status.ExitCode() != 1 || !strings.Contains(string(out), reason) {
		t.Fatalf("expected rejection %q: %v: %s", reason, err, out)
	}
}

// Compare names, modes, bytes and symlink destinations without following links.
func snapshot(t *testing.T, home string) map[string]string {
	t.Helper()
	state := map[string]string{}
	check(t, filepath.Walk(home, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		value := info.Mode().String()
		if info.Mode()&os.ModeSymlink != 0 {
			dest, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += dest
		} else if info.Mode().IsRegular() {
			value += read(t, path)
		}
		state[path] = value
		return nil
	}))
	return state
}

func TestReleaseRejections(t *testing.T) {
	bin := buildInstaller(t)
	for _, tc := range []struct {
		name, reason string
		change       func(*bundle)
	}{
		{"archive digest", "archive checksum", func(b *bundle) { b.archiveDigest = strings.Repeat("0", 64) }},
		{"member digest", "checksum mismatch for", func(b *bundle) { b.files[skillPath] = strings.Repeat("0", 64) }},
		{"extra", "unexpected archive member", func(b *bundle) {
			b.members = append(b.members, member{"orca-plugin/extra", "extra", 0644, tar.TypeReg})
		}},
		{"duplicate", "unexpected archive member", func(b *bundle) { b.members = append(b.members, b.members[1]) }},
		{"missing", "incomplete archive", func(b *bundle) { b.members = b.members[:2] }},
		{"symlink", "unexpected archive member", func(b *bundle) { b.members[1].kind = tar.TypeSymlink }},
		{"hardlink", "unexpected archive member", func(b *bundle) { b.members[1].kind = tar.TypeLink }},
		{"directory", "unexpected archive member", func(b *bundle) { b.members[1].kind = tar.TypeDir }},
		{"local path component", "invalid manifest entry", func(b *bundle) { b.files["orca-plugin/../unused"] = checksum("") }},
		{"resource mode", "unexpected archive member", func(b *bundle) { b.members[1].mode = 0666 }},
		{"binary mode", "unexpected archive member", func(b *bundle) { b.members[0].mode = 0644 }},
		{"version", "incorrect release metadata", func(b *bundle) { b.version = "0.1.0" }},
		{"platform", "incorrect release metadata", func(b *bundle) { b.platform = "other" }},
		{"embedded key", "failed --release-key", func(b *bundle) { b.pin = strings.Repeat("0", 64) }},
		{"binary version", "failed --version", func(b *bundle) {
			b.members[0].data = strings.Replace(b.members[0].data, "2.0.0", "3.0.0", 1)
			b.files["wg"] = checksum(b.members[0].data)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, bin)
			f.release(t, "1.0.0")
			f.run(t, "1.0.0", "")
			b := fixture("2.0.0", f.key)
			tc.change(&b)
			b.save(t, f.prefix("2.0.0"), f.key)
			before := snapshot(t, f.home)
			f.run(t, "2.0.0", tc.reason)
			if !reflect.DeepEqual(before, snapshot(t, f.home)) {
				t.Fatal("rejection changed installation or user files")
			}
		})
	}
}

const root = ".local/share/work-graph"
const launcher = ".local/bin/wg"

func TestInstallationRejections(t *testing.T) {
	bin := buildInstaller(t)
	for _, tc := range []struct {
		name, reason string
		prepare      func(*testing.T, *installation)
	}{
		{"different signer", "current release key", func(t *testing.T, f *installation) {
			_, k, err := ed25519.GenerateKey(rand.Reader)
			check(t, err)
			f.key = k
			f.release(t, "2.0.0")
		}},
		{"signature", "signature check failed", func(t *testing.T, f *installation) { write(t, f.prefix("2.0.0")+".sig", "invalid") }},
		{"active edit", "preserve local change", func(t *testing.T, f *installation) { write(t, f.path(root+"/current/"+skillPath), "user edit") }},
		{"regular launcher", "preserve unmanaged path", func(t *testing.T, f *installation) {
			check(t, os.Remove(f.path(launcher)))
			write(t, f.path(launcher), "user launcher")
		}},
		{"unknown link", "unknown launcher", func(t *testing.T, f *installation) {
			check(t, os.Remove(f.path(launcher)))
			write(t, f.path("package/wg"), "package")
			check(t, os.Symlink(f.path("package/wg"), f.path(launcher)))
		}},
		{"package on PATH", "existing wg on PATH", func(t *testing.T, f *installation) {
			check(t, os.Remove(f.path(launcher)))
			path := f.path("package/bin/wg")
			write(t, path, "package")
			check(t, os.Chmod(path, 0755))
		}},
		{"redirected root", "redirected directory", func(t *testing.T, f *installation) { redirect(t, f.path(root)) }},
		{"redirected versions", "redirected directory", func(t *testing.T, f *installation) { redirect(t, f.path(root+"/versions")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t, bin)
			f.release(t, "1.0.0")
			f.run(t, "1.0.0", "")
			f.release(t, "2.0.0")
			tc.prepare(t, &f)
			before := snapshot(t, f.home)
			f.run(t, "2.0.0", tc.reason, "-migrate-source")
			if !reflect.DeepEqual(before, snapshot(t, f.home)) {
				t.Fatal("rejection changed installation or user files")
			}
		})
	}
}
func redirect(t *testing.T, path string) {
	t.Helper()
	check(t, os.Rename(path, path+".saved"))
	check(t, os.Symlink(path+".saved", path))
}

func TestBootstrap(t *testing.T) {
	f := setup(t, buildInstaller(t))
	f.release(t, "1.0.0")
	legacy := f.path("checkout/skills/work-graph/scripts/wg.py")
	check(t, os.MkdirAll(f.path("checkout/.git"), 0700))
	write(t, legacy, "source edit")
	check(t, os.MkdirAll(filepath.Dir(f.path(launcher)), 0700))
	check(t, os.Symlink(legacy, f.path(launcher)))
	f.run(t, "1.0.0", "source installation")
	dest, err := os.Readlink(f.path(launcher))
	check(t, err)
	if dest != legacy {
		t.Fatal("changed source launcher")
	}
	f.run(t, "1.0.0", "", "-migrate-source")
	// Interrupted after current was installed, before the source link was replaced.
	check(t, os.Remove(f.path(launcher)))
	check(t, os.Symlink(legacy, f.path(launcher)))
	f.run(t, "1.0.0", "", "-migrate-source")
	dest, err = os.Readlink(f.path(launcher))
	check(t, err)
	if dest != f.path(root+"/current/wg") {
		t.Fatal("wrong launcher", dest)
	}
	if read(t, legacy) != "source edit" || read(t, f.path(".config/work-graph/config.json")) != "user config" || read(t, f.path(".config/work-graph/link-token")) != "user token" {
		t.Fatal("migration changed user files")
	}
	f.release(t, "2.0.0")
	f.run(t, "2.0.0", "")
	old := f.path(root + "/versions/1.0.0-" + target() + "/" + skillPath)
	write(t, old, "inactive edit")
	before := snapshot(t, f.home)
	f.run(t, "1.0.0", "newer")
	f.run(t, "3.0.0-rc.1", "MAJOR.MINOR.PATCH")
	if !reflect.DeepEqual(before, snapshot(t, f.home)) {
		t.Fatal("rejection changed installation or user files")
	}
	f.release(t, "3.0.0")
	f.run(t, "3.0.0", "")
	f.run(t, "3.0.0", "")
	if read(t, old) != "inactive edit" || read(t, f.path(root+"/previous/"+skillPath)) != "skill 2.0.0" || read(t, f.path(root+"/current/"+skillPath)) != "skill 3.0.0" {
		t.Fatal("incorrect generations")
	}
}

func TestPackagerArchive(t *testing.T) {
	f := setup(t, buildInstaller(t))
	repo := t.TempDir()
	packager, err := filepath.Abs("../releases/package.py")
	check(t, err)
	run := func(command string, args ...string) {
		t.Helper()
		cmd := exec.Command(command, args...)
		cmd.Dir = repo
		cmd.Env = append(os.Environ(), "HOME="+f.home, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "WG_RELEASE_PUBLIC_KEY="+hex.EncodeToString(f.key.Public().(ed25519.PublicKey)))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s %v: %v: %s", command, args, err, out)
		}
	}
	b := fixture("1.0.0", f.key)
	for _, m := range b.members {
		write(t, filepath.Join(repo, m.name), m.data)
	}
	run("git", "init", "--template=")
	run("git", "add", "--", "skills", "orca-plugin")
	run("git", "-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "resources")
	run("git", "tag", "wg-v1.0.0")
	run("python3", "-I", packager, "build", "wg-v1.0.0", target(), f.assets, "--binary", "wg")
	prefix := f.prefix("1.0.0")
	write(t, prefix+".sig", string(ed25519.Sign(f.key, []byte(read(t, prefix+".json")))))
	f.run(t, "1.0.0", "")
	for _, m := range b.members {
		if read(t, f.path(root+"/current/"+m.name)) != m.data {
			t.Fatalf("incorrect bytes for %s", m.name)
		}
	}
}
