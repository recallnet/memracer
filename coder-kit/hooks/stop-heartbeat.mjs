// coder-kit/hooks/stop-heartbeat.mjs — implementation behind stop-heartbeat.sh.
// Reads the Stop hook input JSON from stdin, asks the memracer server for a
// coder_heartbeat, and blocks the stop while live_leases is non-empty.
// Every failure path exits 0: the hook fails open by design.

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

// The server answers a JSON-RPC POST either as plain JSON or as an SSE
// stream (`data:` lines) depending on transport mode — accept both.
function parseRpcResponse(contentType, body) {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const msg = JSON.parse(line.slice(5).trim());
      if (msg.result) return msg;
    }
    throw new Error("no result message in SSE response");
  }
  return JSON.parse(body);
}

let input = {};
try {
  input = JSON.parse(await readStdin());
} catch {
  // Unparseable hook input: fail open.
}
if (input.stop_hook_active === true) process.exit(0);

const url = process.env.MEMRACER_URL;
const token = process.env.MEMRACER_TOKEN;
if (!url || !token) process.exit(0);

try {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "coder_heartbeat", arguments: {} },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const msg = parseRpcResponse(res.headers.get("content-type") ?? "", await res.text());
  const heartbeat = JSON.parse(msg.result.content[0].text);
  const ids = (heartbeat.live_leases ?? []).map((lease) => lease.task_id);
  if (ids.length > 0) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: `memracer task ${ids.join(", ")} is still leased to you — finish it, then call coder_complete or coder_block before stopping.`,
      }),
    );
  }
} catch (err) {
  console.error(`stop-heartbeat: heartbeat failed, allowing stop: ${err}`);
}
process.exit(0);
