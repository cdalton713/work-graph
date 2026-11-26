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
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func release(t *testing.T, assets, version string, key ed25519.PrivateKey) string {
	t.Helper()
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	target := arch + map[string]string{"darwin": "-apple-darwin", "linux": "-unknown-linux-gnu"}[runtime.GOOS]
	prefix := filepath.Join(assets, "wg-v"+version+"-"+target)
	var b bytes.Buffer
	gz := gzip.NewWriter(&b)
	tarw := tar.NewWriter(gz)
	hashes := map[string]string{}
	for name, data := range map[string]string{"wg": "#!/bin/sh\ncase $1 in --version) echo 'wg " + version + " " + target + "' ;; --release-key) echo '" + hex.EncodeToString(key.Public().(ed25519.PublicKey)) + "' ;; esac\n", "orca-plugin/orca-plugin.json": "{}", "skills/work-graph/SKILL.md": "skill " + version} {
		mode := int64(0644)
		if name == "wg" {
			mode = 0755
		}
		if err := tarw.WriteHeader(&tar.Header{Name: name, Mode: mode, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarw.Write([]byte(data)); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(data))
		hashes[name] = hex.EncodeToString(digest[:])
	}
	if err := tarw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(b.Bytes())
	manifest, _ := json.Marshal(map[string]any{"schema": 1, "target": target, "version": version, "public_key": hex.EncodeToString(key.Public().(ed25519.PublicKey)), "sha256": hex.EncodeToString(digest[:]), "files": hashes, "commit": "0123456789012345678901234567890123456789"})
	for ext, data := range map[string][]byte{".json": manifest, ".tar.gz": b.Bytes(), ".sig": ed25519.Sign(key, manifest)} {
		if err := os.WriteFile(prefix+ext, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return prefix
}

func TestBootstrap(t *testing.T) {
	tmp := t.TempDir()
	installer := filepath.Join(tmp, "install")
	if output, err := exec.Command("go", "build", "-o", installer, "install.go").CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	assets := t.TempDir()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	prefix := release(t, assets, "1.0.0", key)
	home := t.TempDir()
	run := func(version string, ok bool, flags ...string) {
		t.Helper()
		args := append([]string{"-version", version, "-assets", assets, "-key", hex.EncodeToString(pub)}, flags...)
		cmd := exec.Command(installer, args...)
		cmd.Env = []string{"HOME=" + home, "PATH=" + tmp}
		out, err := cmd.CombinedOutput()
		if (err == nil) != ok {
			t.Fatalf("%v: %v %s", args, err, out)
		}
	}
	launcher := filepath.Join(home, ".local/bin/wg")
	legacy := filepath.Join(tmp, "skills/work-graph/scripts/wg.py")
	os.Mkdir(filepath.Join(tmp, ".git"), 0700)
	os.MkdirAll(filepath.Dir(legacy), 0700)
	os.WriteFile(legacy, []byte("local edit"), 0600)
	os.MkdirAll(filepath.Dir(launcher), 0700)
	os.Symlink(legacy, launcher)
	run("1.0.0", false)
	sig, _ := os.ReadFile(prefix + ".sig")
	os.WriteFile(prefix+".sig", make([]byte, 64), 0600)
	run("1.0.0", false, "-migrate-source")
	if got, _ := os.Readlink(launcher); got != legacy {
		t.Fatal("changed source link")
	}
	os.WriteFile(prefix+".sig", sig, 0600)
	run("1.0.0", true, "-migrate-source")
	current := filepath.Join(home, ".local/share/work-graph/current")
	data, err := os.ReadFile(filepath.Join(current, "skills/work-graph/SKILL.md"))
	if err != nil || string(data) != "skill 1.0.0" {
		t.Fatal("missing skill", err)
	}
	if data, _ := os.ReadFile(legacy); string(data) != "local edit" {
		t.Fatal("changed source")
	}
	release(t, assets, "2.0.0", key)
	skill := filepath.Join(current, "skills/work-graph/SKILL.md")
	if err := os.WriteFile(skill, []byte("local edit"), 0600); err != nil {
		t.Fatal(err)
	}
	run("2.0.0", false)
	if data, _ := os.ReadFile(skill); string(data) != "local edit" {
		t.Fatal("changed edited skill")
	}
	if err := os.WriteFile(skill, []byte("skill 1.0.0"), 0600); err != nil {
		t.Fatal(err)
	}
	run("2.0.0", true)
	run("1.0.0", false)
	home = t.TempDir()
	run("1.0.0", true)
	run("1.0.0", true)
	previous := filepath.Join(filepath.Dir(current), "previous", "skills/work-graph/SKILL.md")
	if data, _ := os.ReadFile(previous); string(data) != "skill 1.0.0" {
		t.Fatal("missing previous release")
	}
}
