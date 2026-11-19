import { spawn } from "node:child_process";
import { openSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SupervisorConfig {
  supervisorctlBin: string;
  configPath: string;
  program: string;
  logPath: string;
}

export const DEFAULT_SUPERVISOR: SupervisorConfig = {
  supervisorctlBin: "supervisorctl",
  configPath: "/home/sandbox/supervisord.conf",
  program: "openclaw-gateway",
  logPath: "/home/sandbox/.openclaw/logs/lock-guard-restart.log",
};

export interface RestartHandle {
  pid: number | undefined;
  command: string;
  /**
   * spawn 失败原因（例如容器里没有 supervisorctl），成功则为 null。
   * spawn 成功只代表进程拉起来了，不代表重启生效；非零退出同样算失败。
   */
  failed: Promise<string | null>;
}

export type SpawnFn = typeof spawn;

/**
 * 重启必须由 gateway 进程之外的进程完成，因此交给 supervisord。
 * detached:true 是必须的：配置里 killasgroup=true，supervisord 停止 gateway 时会
 * 杀掉整个进程组，若 supervisorctl 与 gateway 同组会被一起杀掉，重启随即中断。
 *
 * 必须显式监听 error：ChildProcess 的 error 事件无人监听时会作为未捕获异常抛出，
 * 会把 gateway 主进程打崩——检测模块自身的故障就变成了新故障。
 */
export function launchGatewayRestart(
  config: SupervisorConfig = DEFAULT_SUPERVISOR,
  spawnFn: SpawnFn = spawn,
): RestartHandle {
  const args = ["-c", config.configPath, "restart", config.program];
  const command = `${config.supervisorctlBin} ${args.join(" ")}`;
  mkdirSync(dirname(config.logPath), { recursive: true });
  const fd = openSync(config.logPath, "a");

  const child = spawnFn(config.supervisorctlBin, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
  });

  const failed = new Promise<string | null>((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (err) => settle(`spawn error: ${err.message}`));
    child.once("exit", (code, signal) => {
      settle(code === 0 ? null : `exit code=${code ?? "null"} signal=${signal ?? "none"}`);
    });
  });
  // 回调里只有 resolve，不会再抛出；这里兜底防止未来改动引入未处理拒绝。
  failed.catch(() => {});
  child.unref();
  // 子进程已继承 fd，父进程必须关掉自己这份，否则每次重启泄漏一个文件描述符。
  closeSync(fd);

  return { pid: child.pid, command, failed };
}
