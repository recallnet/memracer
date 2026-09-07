import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runHook } from "../human-kit/hooks/sessionstart-status.mjs";

describe("human-kit SessionStart attention hook", () => {
  it("pulls human_status and delivers one clickable notification per episode", async () => {
    const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "memracer-alert-hook-")), "seen.json");
    const alert = {
      episode_id: "44:2",
      project: "demo",
      task_id: 44,
      title: "Restore imports",
      reason: "This task is queued and no coder currently holds a live lease.",
      recovery: "Start a coder; check availability, then claim it explicitly.",
      task_uri: "task://44",
      dashboard_url: "https://memracer.example/?project=demo&task=44",
    };
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ authorization: "Bearer human-token" });
      expect(JSON.parse(String(init.body))).toMatchObject({
        method: "tools/call",
        params: { name: "human_status", arguments: {} },
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ attention_alerts: [alert], projects: {} }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const calls: { command: string; args: string[]; options: { env: Record<string, string> } }[] = [];
    const run = (command: string, args: string[], options: { env: Record<string, string> }) => {
      calls.push({ command, args, options });
      return { status: 0, error: undefined };
    };
    const options = {
      env: {
        MEMRACER_URL: "https://memracer.example/mcp",
        MEMRACER_TOKEN: "human-token",
        MEMRACER_ALERT_STATE_FILE: stateFile,
        MEMRACER_TERMINAL_NOTIFIER: "/trusted/bin/terminal-notifier",
      },
      fetchImpl,
      run,
      platform: "darwin",
      input: [] as string[],
    };

    const first = await runHook(options);
    const second = await runHook(options);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/trusted/bin/terminal-notifier");
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["-open", alert.dashboard_url, "-group", "memracer-44:2"]),
    );
    expect(calls[0].options.env).not.toHaveProperty("MEMRACER_TOKEN");
    expect(Object.keys(calls[0].options.env).some((key) => key.startsWith("MEMRACER_"))).toBe(false);
    expect(first?.hookSpecificOutput.additionalContext).toContain("ATTENTION");
    expect(first?.hookSpecificOutput.additionalContext).toContain("#44 Restore imports");
    expect(second?.hookSpecificOutput.additionalContext).toContain("Full human_status result");
  });

  it("falls back to osascript and fails open when notification tools are absent", async () => {
    const alert = {
      episode_id: "7:1", project: "demo", task_id: 7, title: "Work",
      reason: "No coder holds a live project lease.", recovery: "Start a coder.", task_uri: "task://7", dashboard_url: null,
    };
    const commands: string[] = [];
    const run = (command: string) => {
      commands.push(command);
      return command === "/trusted/bin/terminal-notifier"
        ? { status: null, error: new Error("ENOENT") }
        : { status: 0, error: undefined };
    };
    const file = path.join(mkdtempSync(path.join(tmpdir(), "memracer-alert-hook-")), "seen.json");
    const fetchImpl = async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ attention_alerts: [alert] }) }] },
    }), { headers: { "content-type": "application/json" } });

    await expect(runHook({
      env: {
        MEMRACER_URL: "https://m/mcp", MEMRACER_TOKEN: "t", MEMRACER_ALERT_STATE_FILE: file,
        MEMRACER_TERMINAL_NOTIFIER: "/trusted/bin/terminal-notifier",
      },
      fetchImpl, run, platform: "darwin", input: [],
    })).resolves.toBeTruthy();
    expect(commands).toEqual(["/trusted/bin/terminal-notifier", "/usr/bin/osascript"]);
  });

  it("leaves failed delivery unseen so a later SessionStart retries it", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "memracer-alert-retry-")), "seen.json");
    const alert = {
      episode_id: "8:1", project: "demo", task_id: 8, title: "Retry",
      reason: "No active coder.", recovery: "Start a coder.", task_uri: "task://8", dashboard_url: null,
    };
    const fetchImpl = async () => new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1,
      result: { content: [{ type: "text", text: JSON.stringify({ attention_alerts: [alert] }) }] },
    }), { headers: { "content-type": "application/json" } });
    let attempt = 0;
    const options = {
      env: {
        MEMRACER_URL: "https://m/mcp", MEMRACER_TOKEN: "secret", MEMRACER_ALERT_STATE_FILE: file,
        MEMRACER_TERMINAL_NOTIFIER: "/trusted/notifier",
      },
      fetchImpl,
      run: () => {
        attempt++;
        return { status: attempt >= 3 ? 0 : 1 };
      },
      platform: "darwin",
      input: [] as string[],
    };

    await runHook(options);
    expect(existsSync(file)).toBe(false);
    await runHook(options);
    expect(JSON.parse(readFileSync(file, "utf8")).episode_ids).toEqual(["8:1"]);
  });

  it("serializes cross-process delivery and preserves different concurrent episode ids", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memracer-alert-processes-"));
    const state = path.join(dir, "seen.json");
    const deliveries = path.join(dir, "deliveries.log");
    const hookUrl = new URL("../human-kit/hooks/sessionstart-status.mjs", import.meta.url).href;

    const launch = (episodeId: string) => {
      const code = `
        import { appendFileSync } from "node:fs";
        import { runHook } from ${JSON.stringify(hookUrl)};
        const alert = {
          episode_id: ${JSON.stringify(episodeId)}, project: "demo", task_id: 9,
          title: "Work", reason: "No active coder.",
          recovery: "Start a coder.", task_uri: "task://9", dashboard_url: "https://m/?task=9"
        };
        const fetchImpl = async () => new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:JSON.stringify({attention_alerts:[alert]})}]}}), {headers:{"content-type":"application/json"}});
        const run = (_command, _args, options) => {
          appendFileSync(${JSON.stringify(deliveries)}, JSON.stringify({episode:${JSON.stringify(episodeId)}, leaked:Object.keys(options.env).some(k=>k.startsWith("MEMRACER_"))}) + "\\n");
          return {status:0};
        };
        await runHook({env:{MEMRACER_URL:"https://m/mcp",MEMRACER_TOKEN:"secret",MEMRACER_ALERT_STATE_FILE:${JSON.stringify(state)},MEMRACER_TERMINAL_NOTIFIER:"/trusted/notifier"},fetchImpl,run,platform:"darwin",input:[]});
      `;
      return new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (status) => status === 0 ? resolve() : reject(new Error(stderr || `child exited ${status}`)));
      });
    };

    // Same episode races to one notification.
    await Promise.all([launch("9:1"), launch("9:1")]);
    expect(readFileSync(deliveries, "utf8").trim().split("\n")).toHaveLength(1);

    // Different writers both survive the serialized read/merge/write.
    await Promise.all([launch("10:1"), launch("11:1")]);
    const seen = JSON.parse(readFileSync(state, "utf8")).episode_ids;
    expect(new Set(seen)).toEqual(new Set(["9:1", "10:1", "11:1"]));
    const rows = readFileSync(deliveries, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.leaked === false)).toBe(true);
  });
});
