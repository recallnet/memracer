// Boot smoke: the real entrypoint must come up and serve even in a hostile
// environment (launchd-like stripped PATH, no gh CLI). Completion and server
// startup must not depend on a Git-provider credential or executable.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let child: ChildProcess | undefined;
async function stopChild(): Promise<void> {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null || running.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
  running.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (running.exitCode === null && running.signalCode === null) {
    running.kill("SIGKILL");
    await exited;
  }
}

function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

afterEach(stopChild);

describe("boot smoke (hostile environment)", { retry: 3 }, () => {
  it("contains no verifier or poller boot wiring", () => {
    const source = readFileSync("src/main.ts", "utf8");
    expect(source).not.toMatch(/initVerifier|PrVerificationPoller|verifierDegraded/);
  });

  it("serves the dashboard within 15s with no gh on PATH (fail-closed verify notice ok)", async () => {
    const port = await freePort();
    const dbPath = join(mkdtempSync(join(tmpdir(), "memracer-boot-")), "smoke.db");
    let stderr = "";
    child = spawn(
      process.execPath,
      ["--import", "tsx", "src/main.ts"],
      {
        cwd: process.cwd(),
        env: {
          // launchd-like: no /usr/local/bin, no HOME tooling, no gh anywhere
          PATH: "/usr/bin:/bin",
          HOME: tmpdir(),
          MEMRACER_DB_PATH: dbPath,
          MEMRACER_PORT: String(port),
          MEMRACER_MEDIATOR_DRIVER: "fake",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const deadline = Date.now() + 15_000;
    let status = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break; // crashed — fail below with stderr
      try {
        const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
        status = res.status;
        if (status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(child.exitCode, `server exited during boot; stderr:\n${stderr}`).toBeNull();
    expect(status).toBe(200);
    // Without App/PAT/gh, main.ts logs fail-closed guidance (not a boot failure).
    expect(stderr).toMatch(/PR verification unavailable|App installation|PAT\/gh/);
    await stopChild();
    await expect.poll(() => portAcceptsConnections(port)).toBe(false);
  });
});
