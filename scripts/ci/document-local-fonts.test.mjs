import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plugins = [
  ["documents", "docx"],
  ["pdf", "pdf"],
  ["spreadsheets", "xlsx"],
];
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

for (const [plugin, skill] of plugins) {
  const root = new URL(
    `../../apps/zcode-cli/packages/${plugin}-plugin/skills/${skill}/env_setup/`,
    import.meta.url,
  );
  for (const file of ["setup_windows.ps1", "setup_mac_linux.sh"]) {
    test(`${skill} ${file} font checks have no automatic source or installation`, async () => {
      const source = await readFile(new URL(file, root), "utf8");
      const body = source.slice(
        source.indexOf("# ── Local Font Verification"),
        source.indexOf("# ── Summary"),
      );
      assert.ok(body.length > 100);
      assert.doesNotMatch(
        body,
        /https?:|Invoke-WebRequest|\bcurl\b|New-Item|mkdir|touch|fc-cache|office-skill-fonts-installed/,
      );
      assert.doesNotMatch(body, /font_list\.txt|fonts were (?:just installed|downloaded)/);
      const doc = await readFile(new URL("setup.md", root), "utf8");
      assert.doesNotMatch(doc, /z-cdn\.chatglm\.cn|downloaded individually from CDN/);
    });
  }

  test(
    `${skill} PowerShell checks system CJK without writing or downloading`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "font-check-fixture-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const source = await readFile(new URL("setup_windows.ps1", root), "utf8");
      const body = source.slice(
        source.indexOf("# ── Local Font Verification"),
        source.indexOf("# ── Summary"),
      );
      assert.ok(body.length > 100);
      const fonts = join(dir, "system", "Fonts");
      await mkdir(fonts, { recursive: true });
      await writeFile(join(fonts, "msyh.ttc"), "fixture");
      const harness = join(dir, "check.ps1");
      const quote = (s) => `'${s.replaceAll("'", "''")}'`;
      await writeFile(
        harness,
        `$env:WINDIR=${quote(join(dir, "system"))}\n$env:LOCALAPPDATA=${quote(join(dir, "user"))}\nfunction Write-Ok($m) { Write-Output $m }\nfunction Write-Warn($m) { Write-Output $m }\nfunction Write-Info($m) { Write-Output $m }\nfunction Invoke-WebRequest { throw 'Unexpected network' }\n${body}\nWrite-Output "RESULT=$${skill.toUpperCase()}_FONTS_DIR"\n`,
      );
      const output = execFileSync("pwsh", ["-NoProfile", "-File", harness], { encoding: "utf8" });
      assert.match(output, /CJK font found: msyh.ttc/);
      assert.ok(output.includes(`RESULT=${fonts}`));
      await assert.rejects(access(join(dir, "user")), { code: "ENOENT" });
      await rm(join(fonts, "msyh.ttc"));
      const missing = execFileSync("pwsh", ["-NoProfile", "-File", harness], { encoding: "utf8" });
      assert.match(missing, /No CJK font detected/);
      const parse = `[System.Management.Automation.Language.Parser]::ParseFile(${quote(fileURLToPath(new URL("setup_windows.ps1", root)))},[ref]$null,[ref]$errors) | Out-Null; if ($errors) { $errors | Out-String | Write-Error; exit 1 }`;
      execFileSync("pwsh", ["-NoProfile", "-Command", "$errors=$null; " + parse], {
        encoding: "utf8",
      });
    },
  );

  test(`${skill} quick check tolerates missing fonts without installation`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "font-quick-fixture-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = await readFile(new URL("env_check.sh", root), "utf8");
    const body = source
      .replaceAll('"/Library/Fonts"', '"/missing-font-fixture"')
      .replaceAll('"/System/Library/Fonts"', '"/missing-font-fixture"')
      .replaceAll('"/usr/local/share/fonts"', '"/missing-font-fixture"')
      .replaceAll('"/usr/share/fonts"', '"/missing-font-fixture"');
    const harness = join(dir, "check.sh");
    const posix = (s) => s.replaceAll("\\", "/");
    await writeFile(
      harness,
      `HOME='${posix(join(dir, "home"))}'\nuname() { printf 'Darwin\\n'; }\npython3() { return 0; }\nnode() { return 0; }\nsoffice() { return 0; }\nfc-list() { return 0; }\n${body}`,
    );
    const output = execFileSync(bash, [posix(harness)], { encoding: "utf8" });
    assert.match(output, /WARNING: No CJK font detected/);
    assert.match(output, /FONT_DIR=\s*$/);
    await assert.rejects(access(join(dir, "home")), { code: "ENOENT" });
    execFileSync(bash, ["-n", posix(fileURLToPath(new URL("env_check.sh", root)))]);
  });

  test(`${skill} Bash checks macOS and Linux local fonts without installing`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "font-posix-fixture-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = await readFile(new URL("setup_mac_linux.sh", root), "utf8");
    const body = source.slice(
      source.indexOf("# ── Local Font Verification"),
      source.indexOf("# ── Summary"),
    );
    assert.ok(body.length > 100);
    const posix = (s) => s.replaceAll("\\", "/");
    const system = posix(join(dir, "system"));
    await mkdir(system, { recursive: true });
    await writeFile(join(system, "PingFang.ttc"), "fixture");
    const harness = join(dir, "check.sh");
    const isolated = body
      .replaceAll('"/Library/Fonts"', `"${system}"`)
      .replaceAll('"/System/Library/Fonts"', '"/missing-font-fixture"')
      .replaceAll('"/usr/local/share/fonts"', '"/missing-font-fixture"')
      .replaceAll('"/usr/share/fonts"', `"${system}"`);
    await writeFile(
      harness,
      `set -euo pipefail\nHOME='${posix(join(dir, "home"))}'\nPLATFORM="$1"\nok() { printf '%s\\n' "$1"; }\nwarn() { printf '%s\\n' "$1"; }\ninfo() { printf '%s\\n' "$1"; }\ncurl() { return 99; }\nfc-list() { return 1; }\n${isolated}\nprintf 'RESULT=%s\\n' "$FONT_DIR"\n`,
    );
    for (const platform of ["mac", "linux"]) {
      const output = execFileSync(bash, [posix(harness), platform], { encoding: "utf8" });
      assert.match(output, /CJK fonts available/);
      assert.ok(output.includes(`RESULT=${system}`));
    }
    await assert.rejects(access(join(dir, "home")), { code: "ENOENT" });
    assert.deepEqual(await readdir(system), ["PingFang.ttc"]);
    execFileSync(bash, ["-n", posix(fileURLToPath(new URL("setup_mac_linux.sh", root)))]);
  });
}
