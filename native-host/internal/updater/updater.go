// Package updater checks for and installs sing-box core updates from GitHub.
package updater

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const singboxReleaseAPI = "https://api.github.com/repos/SagerNet/sing-box/releases/latest"

// У http.DefaultClient нет таймаута вообще: на сети, где GitHub придушен (а это
// профильная ситуация для наших пользователей), запрос повисал навсегда — и
// вместе с ним весь хост, потому что handle() обслуживает команды из одного
// цикла. Два клиента, потому что бюджеты разные: ответ API — секунды, скачивание
// архива ~30 МБ на медленном канале — минуты. Timeout покрывает весь обмен,
// включая чтение тела.
var (
	apiClient      = &http.Client{Timeout: 30 * time.Second}
	downloadClient = &http.Client{Timeout: 10 * time.Minute}
)

type asset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

type release struct {
	TagName string  `json:"tag_name"`
	Assets  []asset `json:"assets"`
}

func httpGet(client *http.Client, url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "MagicProxy-Updater")
	return client.Do(req)
}

// LatestSingBox returns the latest release tag (e.g. "v1.13.14") and the
// windows-amd64 archive download URL.
func LatestSingBox() (tag, url string, err error) {
	resp, err := httpGet(apiClient, singboxReleaseAPI)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", "", fmt.Errorf("github api status %d", resp.StatusCode)
	}
	var rel release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", "", err
	}
	for _, a := range rel.Assets {
		if strings.HasSuffix(a.Name, "windows-amd64.zip") && !strings.Contains(a.Name, "legacy") {
			return rel.TagName, a.URL, nil
		}
	}
	return rel.TagName, "", fmt.Errorf("no windows-amd64 asset in %s", rel.TagName)
}

var versionRe = regexp.MustCompile(`(\d+\.\d+\.\d+)`)

// NormalizeVersion extracts x.y.z from strings like "v1.13.14" or "1.13.14".
func NormalizeVersion(s string) string {
	m := versionRe.FindString(s)
	return m
}

// InstallSingBox downloads the archive at url and writes sing-box.exe to destExe
// (atomically via a temp file + rename). The caller must ensure no sing-box
// process is currently using destExe.
func InstallSingBox(url, destExe string) error {
	resp, err := httpGet(downloadClient, url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download status %d", resp.StatusCode)
	}

	tmpZip, err := os.CreateTemp("", "singbox-*.zip")
	if err != nil {
		return err
	}
	tmpZipPath := tmpZip.Name()
	defer os.Remove(tmpZipPath)
	if _, err := io.Copy(tmpZip, resp.Body); err != nil {
		tmpZip.Close()
		return err
	}
	tmpZip.Close()

	zr, err := zip.OpenReader(tmpZipPath)
	if err != nil {
		return err
	}
	defer zr.Close()

	var found *zip.File
	for _, f := range zr.File {
		if filepath.Base(f.Name) == "sing-box.exe" {
			found = f
			break
		}
	}
	if found == nil {
		return fmt.Errorf("sing-box.exe not found in archive")
	}

	rc, err := found.Open()
	if err != nil {
		return err
	}
	defer rc.Close()

	tmpExe := destExe + ".new"
	out, err := os.Create(tmpExe)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		os.Remove(tmpExe)
		return err
	}
	out.Close()

	if err := replaceFile(destExe, tmpExe); err != nil {
		os.Remove(tmpExe)
		return err
	}
	return nil
}

// replaceFile atomically swaps dest with src. On Windows, antivirus (Defender)
// often holds a transient lock on a freshly written .exe while scanning it, so
// we move the old file aside first and retry the swap with backoff.
func replaceFile(dest, src string) error {
	bak := dest + ".bak"
	_ = os.Remove(bak)

	var lastErr error
	for attempt := 0; attempt < 12; attempt++ {
		// Move the current binary aside (ignored if it doesn't exist yet).
		if _, err := os.Stat(dest); err == nil {
			if err := os.Rename(dest, bak); err != nil {
				lastErr = err
				time.Sleep(300 * time.Millisecond)
				continue
			}
		}
		// Put the new binary in place.
		if err := os.Rename(src, dest); err != nil {
			lastErr = err
			// Roll the old one back so we never leave dest missing.
			if _, statErr := os.Stat(bak); statErr == nil {
				_ = os.Rename(bak, dest)
			}
			time.Sleep(300 * time.Millisecond)
			continue
		}
		removeWithRetry(bak)
		return nil
	}
	return lastErr
}

// removeWithRetry best-effort deletes a file that AV may still be scanning.
func removeWithRetry(path string) {
	for i := 0; i < 6; i++ {
		if err := os.Remove(path); err == nil || os.IsNotExist(err) {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}
