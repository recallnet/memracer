import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export function parseToolResult(result: { content?: unknown }): any {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0].text);
}

export async function waitForHumanJob(client: Client, jobId: number): Promise<any> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const job = parseToolResult(await client.callTool({
      name: "human_job_status",
      arguments: { job_id: jobId },
    }));
    if (job.status === "done") return job.result;
    if (job.status === "failed") throw new Error(`human job ${jobId} failed: ${job.error}`);
    if (Date.now() >= deadline) throw new Error(`human job ${jobId} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Compatibility shape for tests whose subject is the eventual groom verdict. */
export async function submitAndWait(client: Client, args: Record<string, unknown>): Promise<any> {
  const ack = parseToolResult(await client.callTool({ name: "human_submit", arguments: args }));
  if (!ack.job_id) return ack;
  const grooming = await waitForHumanJob(client, ack.job_id);
  if (grooming.action === "refuse" && grooming.removed !== false) {
    return { ...ack, task: null, grooming };
  }
  const taskId = grooming.action === "merge" ? grooming.into_task_id : ack.task_id;
  const status = parseToolResult(await client.callTool({
    name: "human_task_status",
    arguments: { task_id: taskId },
  }));
  return { ...ack, task: status.task, grooming };
}

export async function discussAndWait(client: Client, args: Record<string, unknown>): Promise<any> {
  const ack = parseToolResult(await client.callTool({ name: "human_discuss", arguments: args }));
  return waitForHumanJob(client, ack.job_id);
}

export async function enhanceAndWait(client: Client, args: Record<string, unknown>): Promise<any> {
  const ack = parseToolResult(await client.callTool({ name: "human_enhance", arguments: args }));
  const verdict = await waitForHumanJob(client, ack.job_id);
  const status = parseToolResult(await client.callTool({
    name: "human_task_status",
    arguments: { task_id: ack.task_id },
  }));
  return { ...ack, verdict, task: status.task };
}
