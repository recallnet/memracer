// tests/fixtures/stub-coder.mjs — stands in for the `claude` binary in
// coder-kit supervisor tests. Reads the brief file and env the supervisor
// provides, then drives the real coder_* MCP tools like a session would.
//
// STUB_MODE=hang: never talks to the server; sits forever so the supervisor
// watchdog has something to kill.
// STUB_MODE=premature-exit: the first session exits with its claim still live;
// the recovery session continues through the normal lifecycle.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const brief = JSON.parse(readFileSync(process.env.MEMRACER_TASK_FILE, "utf8"));
const mode = process.env.STUB_MODE ?? "normal";
console.log(`[stub] pid=${process.pid} task=${brief.id} mode=${mode}`);

if (mode === "hang") {
  setInterval(() => {}, 60_000); // hang forever
} else {
  const client = new Client({ name: "stub-coder", version: "0.0.1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(process.env.MEMRACER_URL), {
      requestInit: { headers: { Authorization: `Bearer ${process.env.MEMRACER_TOKEN}` } },
    }),
  );
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args });
    return JSON.parse(res.content[0].text);
  };

  if (mode === "premature-exit" && !existsSync(process.env.STUB_PREMATURE_EXIT_FILE)) {
    writeFileSync(process.env.STUB_PREMATURE_EXIT_FILE, "exited");
    await client.close();
    process.exit(0);
  }

  const review = await call("coder_propose_plan", {
    task_id: brief.id,
    plan: `solid plan: satisfy the acceptance criteria of "${brief.title}"`,
    files_touched: ["src/example.ts"],
  });
  if (review.verdict !== "approved") {
    console.error(`[stub] plan not approved: ${JSON.stringify(review)}`);
    process.exit(2);
  }

  if (mode === "goal-progress") {
    let progressStopped = false;
    for (;;) {
      if (process.env.STUB_PROGRESS_STOP_FILE && existsSync(process.env.STUB_PROGRESS_STOP_FILE)) {
        if (!progressStopped && process.env.STUB_PROGRESS_STOPPED_FILE) {
          writeFileSync(process.env.STUB_PROGRESS_STOPPED_FILE, "stopped");
        }
        progressStopped = true;
      } else {
        await call("coder_progress", { task_id: brief.id, note: "goal still progressing" });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  await call("coder_progress", { task_id: brief.id, note: "working" });
  await call("coder_complete", {
    task_id: brief.id,
    summary: "done",
    pr_url: `https://github.com/recallnet/demo/pull/${brief.id}`,
    pr_description: `Stub PR implementing task ${brief.id}: ${brief.title}.`,
    verification: `stub-coder completed task ${brief.id} via fixture path`,
  });
  await client.close();
  process.exit(0);
}
