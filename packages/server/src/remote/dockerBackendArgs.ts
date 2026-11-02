import type { DockerContainerInfo } from "@zcode/shared";
import type { ChildProcess } from "node:child_process";

/**
 * Docker backend 的 argv 组装、输出归一化等无 IO 纯辅助与局部类型。
 * docker-backend.ts 只 import 这里的内容，本文件不反向引用父文件，避免循环依赖。
 */
export interface ResolvedDockerInfo {
  containerName: string;
  homeDir: string;
}

/** 本 backend 自己 spawn 的 exec 子进程所有权条目；closed 在 exit/close/可摘除 error 时收敛。 */
export interface OwnedExecChild {
  child: ChildProcess;
  closed: Promise<void>;
  resolveClosed(): void;
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function normalizeDockerOutput(raw: string): string {
  return raw.replace(/\r/g, "");
}

export function buildDockerExecArgs(containerName: string, commandArgs: string[]): string[] {
  // 直接 exec/read 跳过容器枚举后失去了隐式校验；在组装 argv 处拒绝选项形态和非法引用。
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(containerName)) {
    throw new Error("Invalid Docker container reference");
  }
  return ["exec", "-i", containerName, ...commandArgs];
}

export function resolveLinuxPath(remotePath: string, homeDir: string): string {
  if (remotePath === "~") {
    return homeDir;
  }

  if (remotePath.startsWith("~/")) {
    return `${homeDir.replace(/\/$/, "")}/${remotePath.slice(2)}`;
  }

  return remotePath;
}

export function dirname(remotePath: string): string {
  const normalized = remotePath.replace(/\/+/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }

  return normalized.slice(0, lastSlash);
}

export function selectRunningDockerContainer(
  containers: DockerContainerInfo[],
  containerRef: string,
): DockerContainerInfo {
  const matched = containers.find(
    (container) =>
      container.name === containerRef ||
      container.id === containerRef ||
      container.id.startsWith(containerRef),
  );

  if (!matched) {
    throw new Error(`未找到名为 ${containerRef} 的 Docker 容器`);
  }

  if (matched.state.toLowerCase() !== "running") {
    throw new Error(
      `Docker 容器 ${matched.name} 当前未运行（state=${matched.state || "unknown"}）`,
    );
  }

  return matched;
}
