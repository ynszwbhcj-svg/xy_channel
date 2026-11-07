import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { launchGatewayRestart, type SupervisorConfig } from "../src/session-lock-guard/supervisor.js";

const CONFIG: SupervisorConfig = {
  supervisorctlBin: "supervisorctl",
  configPath: "/home/sandbox/supervisord.conf",
  program: "openclaw-gateway",
  logPath: "/tmp/lock-guard-test.log",
};

function fakeChild(pid: number | undefined) {
  const child = new EventEmitter() as EventEmitter & { pid: number | undefined; unref: () => void };
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

describe("launchGatewayRestart", () => {
  it("launches supervisorctl detached with the restart subcommand", () => {
    const child = fakeChild(777);
    const spawnFn = vi.fn(() => child) as never;

    const handle = launchGatewayRestart(CONFIG, spawnFn);

    const [bin, args, options] = (spawnFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe("supervisorctl");
    expect(args).toEqual(["-c", "/home/sandbox/supervisord.conf", "restart", "openclaw-gateway"]);
    // killasgroup=true 会杀掉 gateway 整个进程组，子进程必须独立成组才能活下来执行重启。
    expect(options.detached).toBe(true);
    expect(options.stdio[0]).toBe("ignore");
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(handle.pid).toBe(777);
    expect(handle.command).toContain("restart openclaw-gateway");
  });

  it("registers an error listener so a missing binary cannot crash the gateway", async () => {
    const child = fakeChild(undefined);
    const handle = launchGatewayRestart(CONFIG, vi.fn(() => child) as never);

    expect(child.listenerCount("error")).toBeGreaterThan(0);
    // 未监听的 error 事件会作为未捕获异常抛出，这里必须能安全触发。
    expect(() => child.emit("error", new Error("spawn supervisorctl ENOENT"))).not.toThrow();
    await expect(handle.failed).resolves.toContain("ENOENT");
  });

  it("treats a non-zero supervisorctl exit as a failed restart", async () => {
    const child = fakeChild(778);
    const handle = launchGatewayRestart(CONFIG, vi.fn(() => child) as never);
    child.emit("exit", 1, null);
    await expect(handle.failed).resolves.toContain("exit code=1");
  });

  it("reports success on a zero exit", async () => {
    const child = fakeChild(779);
    const handle = launchGatewayRestart(CONFIG, vi.fn(() => child) as never);
    child.emit("exit", 0, null);
    await expect(handle.failed).resolves.toBeNull();
  });
});
