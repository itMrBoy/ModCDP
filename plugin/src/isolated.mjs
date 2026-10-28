import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
const runFile = promisify(execFile);

export function snowExecutable(explicit) {
  const candidates = [
    explicit,
    process.platform === "win32" &&
      path.join(process.env.LOCALAPPDATA ?? "", "SnowEnterpriseBrowser/Application/snowview.exe"),
    process.platform === "darwin" && "/Applications/Snow Browser.app/Contents/MacOS/Snow Browser",
  ].filter(Boolean);
  const found = candidates.find((p) => path.isAbsolute(p) && existsSync(p));
  if (!found || !/^(snowview(?:\.exe)?|Snow Browser)$/i.test(path.basename(found))) {
    throw new Error(
      "Snow executable not found. Provide the installed snowview executable path; no other browser is substituted.",
    );
  }
  return path.resolve(found);
}

export async function launchIsolated(home, instanceId, executable, startupUrl = "about:blank") {
  const resolvedExecutable = snowExecutable(executable);
  const base = path.join(home, "profiles");
  await mkdir(base, { recursive: true });
  const profile = await mkdtemp(path.join(base, "isolated-"));
  const proc = spawn(resolvedExecutable, [`--user-data-dir=${profile}`, "--no-first-run", startupUrl], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    proc.once("spawn", resolve);
    proc.once("error", reject);
  });
  const record = {
    instance_id: instanceId,
    profile,
    executable: resolvedExecutable,
    pid: proc.pid ?? null,
    created_at: new Date().toISOString(),
    mode: "isolated",
  };
  await writeFile(path.join(profile, ".snow-browser-owner.json"), JSON.stringify(record));
  proc.unref();
  return { record, proc };
}

export async function cleanIsolated(home, record) {
  const base = await realpath(path.join(home, "profiles"));
  const profile = await realpath(record.profile);
  if (path.dirname(profile) !== base || !path.basename(profile).startsWith("isolated-"))
    throw new Error("Refusing cleanup outside the owned profile directory.");
  const marker = JSON.parse(await readFile(path.join(profile, ".snow-browser-owner.json"), "utf8"));
  if (marker.instance_id !== record.instance_id || marker.pid !== record.pid || marker.executable !== record.executable)
    throw new Error("Profile ownership mismatch.");
  // Called only after explicit close-and-clean confirmation. Verify current process
  // identity and its exact profile argument; never terminate a remembered PID.
  if (process.platform === "win32") {
    const escaped = profile.replaceAll("'", "''");
    const executable = record.executable?.replaceAll("'", "''");
    if (!executable)
      throw new Error("Missing executable ownership information; close the isolated browser manually before cleanup.");
    const { stdout: output } = await runFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'
      $ownedProfile='${escaped}'
      $ownedExe='${executable}'
      $arg=[regex]::Escape($ownedProfile)
      $pattern='(?:^|\\s)(?:"--user-data-dir='+$arg+'"|--user-data-dir="'+$arg+'"|--user-data-dir='+$arg+')(?=\\s|$)'
      function Find-Owned {
        $matches=@(Get-CimInstance Win32_Process -Filter "Name='snowview.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace([char]47,[char]92) -match $pattern })
        foreach ($item in $matches) { if ($item.ExecutablePath -ne $ownedExe) { throw 'Isolated process executable mismatch; refusing cleanup' } }
        $matches
      }
      foreach ($item in (Find-Owned)) { $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($process) { $null=$process.CloseMainWindow() } }
      $deadline=[DateTime]::UtcNow.AddSeconds(8)
      while ((Find-Owned).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
      foreach ($item in (Find-Owned)) {
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.ProcessId)
        if ($current -and $current.CreationDate -eq $item.CreationDate -and $current.ExecutablePath -eq $ownedExe -and $current.CommandLine.Replace([char]47,[char]92) -match $pattern) { Stop-Process -Id $current.ProcessId -ErrorAction Stop }
      }
      $deadline=[DateTime]::UtcNow.AddSeconds(5)
      while ((Find-Owned).Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
      (Find-Owned).Count`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 40000 },
    );
    if (Number(output.trim()) !== 0)
      throw new Error(
        "The isolated Snow process is still using this profile. Close that window, then confirm cleanup again.",
      );
  } else {
    try {
      process.kill(record.pid, 0);
      throw new Error("The isolated browser is still running; close its window before profile cleanup.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  await rm(profile, { recursive: true, force: false });
}
