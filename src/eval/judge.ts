// src/eval/judge.ts — hand-rolled LLM-as-judge for arbitration quality.
//
// The Tier-B stochastic eval (stochastic.ts) grades the mediator's arbitration
// on a per-dimension DISCRETE rubric and a pairwise comparison against the
// golden reference. The whole LLM surface is one injectable `JudgeChat`
// function: the real path (makeOpenRouterJudge) hits OpenRouter with a STRONG
// judge model DIFFERENT from the model under test at temperature 0; tests inject
// a deterministic fake. Keeping the library behind this one module makes
// autoevals 0.3.0 a one-file swap, mirroring the agentevals adapter in
// trajectory.ts. Two position-bias mitigations per the τ-bench / LLM-judge
// literature: the judge scores discretely, and pairwise runs BOTH orderings and
// treats a flip (the two orderings disagreeing) as a tie.

export type JudgeMessage = { role: "system" | "user"; content: string };

/** The single LLM seam: chat messages in, raw model text out. */
export type JudgeChat = (messages: JudgeMessage[]) => Promise<string>;

/** Discrete rubric dimensions scored 1..5 (higher is better). */
export const JUDGE_DIMENSIONS = ["decision_correctness", "rationale_grounding", "feedback_actionability"] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];

export type DimensionScores = Record<JudgeDimension, number>;

export interface JudgeCase {
  scenario: string;
  /** The mediator's observed action trajectory (decision kinds). */
  candidateKinds: string[];
  /** The golden reference action trajectory for this scenario. */
  referenceKinds: string[];
}

const JUDGE_SYSTEM =
  "You are a strict, impartial evaluator of an autonomous task-mediator's arbitration decisions. " +
  "You never make decisions yourself; you only grade. Reply with a single JSON object, no prose.";

const RUBRIC_MIN = 1;
const RUBRIC_MAX = 5;

function clampDiscrete(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return RUBRIC_MIN;
  return Math.min(RUBRIC_MAX, Math.max(RUBRIC_MIN, n));
}

/** Pull the first JSON object out of a model reply (tolerates code fences / prose). */
function parseJsonObject(text: string): Record<string, unknown> {
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error(`judge returned no JSON object: ${text.slice(0, 200)}`);
  return JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * Score one arbitration on the discrete per-dimension rubric. The judge sees the
 * scenario, the candidate action sequence, and the golden reference, and returns
 * an integer 1..5 per dimension.
 */
export async function scoreDimensions(chat: JudgeChat, c: JudgeCase): Promise<DimensionScores> {
  const user =
    `Scenario: ${c.scenario}\n` +
    `Mediator action sequence (candidate): [${c.candidateKinds.join(", ")}]\n` +
    `Golden reference action sequence: [${c.referenceKinds.join(", ")}]\n\n` +
    `Rate the candidate arbitration on each dimension with an integer ${RUBRIC_MIN}..${RUBRIC_MAX} ` +
    `(${RUBRIC_MIN}=poor, ${RUBRIC_MAX}=excellent):\n` +
    `- decision_correctness: did it take the right actions for this scenario?\n` +
    `- rationale_grounding: are the actions justified by the scenario facts (no invention)?\n` +
    `- feedback_actionability: would the resulting feedback/decision be clear and actionable?\n` +
    `Reply as JSON: {"decision_correctness":n,"rationale_grounding":n,"feedback_actionability":n}`;
  const raw = await chat([
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: user },
  ]);
  const obj = parseJsonObject(raw);
  return {
    decision_correctness: clampDiscrete(obj.decision_correctness),
    rationale_grounding: clampDiscrete(obj.rationale_grounding),
    feedback_actionability: clampDiscrete(obj.feedback_actionability),
  };
}

export type PairwiseVerdict = "candidate" | "reference" | "tie";

/** Ask the judge which of two labeled arbitrations (A, B) is the better one. */
async function pickWinner(chat: JudgeChat, scenario: string, aKinds: string[], bKinds: string[]): Promise<"A" | "B" | "tie"> {
  const user =
    `Scenario: ${scenario}\n` +
    `Arbitration A action sequence: [${aKinds.join(", ")}]\n` +
    `Arbitration B action sequence: [${bKinds.join(", ")}]\n\n` +
    `Which arbitration handles the scenario better? Reply as JSON {"winner":"A"} or {"winner":"B"} ` +
    `(or {"winner":"tie"} if genuinely equal).`;
  const raw = await chat([
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: user },
  ]);
  const w = String(parseJsonObject(raw).winner ?? "").toUpperCase();
  if (w === "A") return "A";
  if (w === "B") return "B";
  return "tie";
}

/**
 * Pairwise compare the candidate arbitration against the golden reference,
 * running BOTH orderings and treating a flip as a tie. In ordering 1 the
 * candidate is slot A; in ordering 2 the candidate is slot B. If the two
 * orderings disagree on the real winner, the judge exhibited position bias and
 * we score a tie.
 */
export async function pairwiseCompare(chat: JudgeChat, c: JudgeCase): Promise<PairwiseVerdict> {
  const order1 = await pickWinner(chat, c.scenario, c.candidateKinds, c.referenceKinds);
  const order2 = await pickWinner(chat, c.scenario, c.referenceKinds, c.candidateKinds);
  // Map each ordering's slot-answer to the real entity it chose.
  const w1: PairwiseVerdict = order1 === "A" ? "candidate" : order1 === "B" ? "reference" : "tie";
  const w2: PairwiseVerdict = order2 === "A" ? "reference" : order2 === "B" ? "candidate" : "tie";
  if (w1 === "tie" || w2 === "tie") return "tie";
  return w1 === w2 ? w1 : "tie";
}

/**
 * The real judge: an OpenRouter chat completion at temperature 0 using a STRONG
 * model that MUST differ from the model under test (guarded — a judge that is
 * the same model as the candidate leaks self-preference bias).
 */
export function makeOpenRouterJudge(
  apiKey: string,
  judgeModel: string,
  modelUnderTest: string,
  baseUrl = "https://openrouter.ai/api/v1",
  fetchImpl: typeof fetch = fetch,
): JudgeChat {
  if (judgeModel === modelUnderTest) {
    throw new Error(
      `judge model must differ from the model under test (both "${judgeModel}") — a self-judge leaks self-preference bias`,
    );
  }
  return async (messages: JudgeMessage[]): Promise<string> => {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: judgeModel,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`judge completion failed: ${res.status}`);
    const data = (await res.json()) as { choices: { message: { content: string | null } }[] };
    return data.choices[0]?.message?.content ?? "";
  };
}
