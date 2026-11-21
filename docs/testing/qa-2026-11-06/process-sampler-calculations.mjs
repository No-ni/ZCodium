// 原因：排版后旧采样器超过行数门禁；纯计算无 IO、缓存或采样状态，原入口继续唯一调度。
export const normalize = (value) => value.replaceAll("\\", "/").toLowerCase();

export function windowsTokens(command) {
  const tokens = [];
  let token = "";
  let quoted = false;
  let active = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (character === "\\") {
      let count = 1;
      while (command[index + count] === "\\") count++;
      if (command[index + count] === '"') {
        token += "\\".repeat(Math.floor(count / 2));
        if (count % 2) token += '"';
        else quoted = !quoted;
        index += count;
      } else {
        token += "\\".repeat(count);
        index += count - 1;
      }
      active = true;
    } else if (character === '"') {
      quoted = !quoted;
      active = true;
    } else if (/\s/u.test(character) && !quoted) {
      if (active) tokens.push(token);
      token = "";
      active = false;
    } else {
      token += character;
      active = true;
    }
  }
  if (quoted) return null;
  if (active) tokens.push(token);
  return tokens;
}

export function exactOption(tokens, key, expected, pathValue = false) {
  if (!tokens) return false;
  const candidates = tokens.filter(
    (token) => token.toLowerCase() === key || token.toLowerCase().startsWith(key + "="),
  );
  if (candidates.length !== 1 || !candidates[0].startsWith(key + "=")) return false;
  const actual = candidates[0].slice(key.length + 1);
  return pathValue ? normalize(actual) === normalize(expected) : actual === expected;
}

export function marker(command, key, value, pathValue = false) {
  return exactOption(windowsTokens(command), key, value, pathValue);
}

export function descendants(rows, rootPid) {
  const included = new Set(rows.some((row) => row.pid === rootPid) ? [rootPid] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const parent = included.has(row.ppid) && rows.find((candidate) => candidate.pid === row.ppid);
      if (
        !included.has(row.pid) &&
        parent &&
        Date.parse(row.createdAt) >= Date.parse(parent.createdAt)
      ) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => included.has(row.pid));
}

export function cpuPercent(row, previous, capturedAt) {
  if (!previous || previous.createdAt !== row.createdAt || capturedAt <= previous.capturedAt)
    return null;
  const deltaTicks = Number(BigInt(row.cpuTicks) - BigInt(previous.cpuTicks));
  return deltaTicks < 0 ? null : (deltaTicks / 10000 / (capturedAt - previous.capturedAt)) * 100;
}

export function matchesSamplerMain(row, { repository, targetRunId, targetHome, appEntry }) {
  const tokens = windowsTokens(row.command);
  return (
    /^(?:electron|zcodium)\.exe$/iu.test(row.name) &&
    normalize(row.executable).startsWith(normalize(repository) + "/") &&
    exactOption(tokens, "--zcode-e2e-run-id", targetRunId) &&
    exactOption(tokens, "--zcode-e2e-home", targetHome, true) &&
    exactOption(tokens, "--app", appEntry, true) &&
    !tokens.some((token) => /^--type(?:=|$)/iu.test(token))
  );
}

export function role(row, mainPid, perf) {
  if (row.pid === mainPid) return { role: "main", roleSource: "exact-main-identity" };
  if (/--type=renderer(?:\s|$)/iu.test(row.command))
    return { role: "renderer", roleSource: "chromium-type" };
  const metric = perf?.metrics?.find((item) => item.pid === row.pid);
  if (metric?.name?.startsWith("zcode-host-"))
    return { role: "host", roleSource: "existing-WDIO-perf-service-name" };
  if (metric?.name === "zcode-cron-scheduler")
    return { role: "scheduler", roleSource: "existing-WDIO-perf-service-name" };
  if (metric?.type)
    return {
      role: metric.type === "GPU" ? "gpu" : "utility",
      roleSource: "existing-WDIO-perf-type",
    };
  return {
    role: /--utility-sub-type=node\.mojom\.NodeService/iu.test(row.command)
      ? "node-utility-unclassified"
      : "descendant-unclassified",
    roleSource: "command-type-only",
  };
}

export function parseProcessRows(raw) {
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ""),
    executable: String(row.ExecutablePath ?? ""),
    command: String(row.CommandLine ?? ""),
    createdAt: String(row.CreatedAt ?? ""),
    cpuTicks: String(row.CpuTicks ?? "0"),
    workingSetBytes: Number(row.WorkingSetSize),
    threads: Number(row.ThreadCount),
    handles: Number(row.HandleCount),
  }));
}
