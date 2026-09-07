/**
 * Durable, identity-keyed negotiation store for multi-round interrogation
 * before accept (task #420). State survives disconnects; re-attach by id.
 */
import type { Db } from "./db.js";

export type NegotiationState =
  | "open"
  | "awaiting_party"
  | "awaiting_person"
  | "accepted"
  | "declined"
  | "cancelled";

const TERMINAL: NegotiationState[] = ["accepted", "declined", "cancelled"];

export interface Negotiation {
  id: string;
  project_id: string;
  subject_kind: "submission" | "coder_plan";
  subject_task_id: number;
  party_identity: string;
  party_role: "human" | "coder";
  state: NegotiationState;
  current_prompt: string | null;
  awaiting_identity: string | null;
  transcript: string;
  /** Durable link to the open questions ledger row for this prompt (#473). */
  question_id: number | null;
  created_at: number;
  updated_at: number;
}

export type TranscriptEntry = {
  from: string;
  kind: "question" | "answer";
  content: string;
  at: number;
};

export class NegotiationStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async open(input: {
    projectId: string;
    subjectKind: "submission" | "coder_plan";
    subjectTaskId: number;
    partyIdentity: string;
    partyRole: "human" | "coder";
  }): Promise<Negotiation> {
    return this.db.transaction(async () => {
      const existing = await this.openForSubject(input.subjectTaskId);
      if (existing) {
        throw new Error(`task ${input.subjectTaskId} already has an open negotiation`);
      }
      const now = this.clock();
      const id = `neg_${input.subjectTaskId}_${now}`;
      await this.db
        .prepare(
          `INSERT INTO negotiations
             (id, project_id, subject_kind, subject_task_id, party_identity, party_role,
              state, transcript, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', '[]', ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.subjectKind,
          input.subjectTaskId,
          input.partyIdentity,
          input.partyRole,
          now,
          now,
        );
      return (await this.get(id))!;
    });
  }

  async get(id: string): Promise<Negotiation | null> {
    return (
      (await this.db.prepare("SELECT * FROM negotiations WHERE id = ?").get<Negotiation>(id)) ?? null
    );
  }

  async openForSubject(taskId: number): Promise<Negotiation | null> {
    return (
      (await this.db
        .prepare(
          `SELECT * FROM negotiations
           WHERE subject_task_id = ? AND state NOT IN ('accepted','declined','cancelled')
           LIMIT 1`,
        )
        .get<Negotiation>(taskId)) ?? null
    );
  }

  async listOpenForParty(partyIdentity: string): Promise<Negotiation[]> {
    return this.db
      .prepare(
        `SELECT * FROM negotiations
         WHERE party_identity = ? AND state IN ('open','awaiting_party','awaiting_person')
         ORDER BY updated_at DESC`,
      )
      .all<Negotiation>(partyIdentity);
  }

  private async append(id: string, entry: TranscriptEntry): Promise<string> {
    const cur = await this.get(id);
    const transcript: TranscriptEntry[] = cur ? (JSON.parse(cur.transcript) as TranscriptEntry[]) : [];
    transcript.push(entry);
    return JSON.stringify(transcript);
  }

  /** Frigg poses the open question. personOwned routes to awaiting_person. */
  async ask(
    id: string,
    askedBy: string,
    question: string,
    opts: { personOwned?: boolean; questionId?: number | null } = {},
  ): Promise<void> {
    const n = await this.get(id);
    if (!n || TERMINAL.includes(n.state)) {
      throw new Error(`negotiation ${id} cannot accept a question`);
    }
    const now = this.clock();
    const transcript = await this.append(id, {
      from: askedBy,
      kind: "question",
      content: question,
      at: now,
    });
    const state: NegotiationState = opts.personOwned ? "awaiting_person" : "awaiting_party";
    const awaiting = n.party_identity;
    const questionId = opts.questionId ?? null;
    await this.db
      .prepare(
        `UPDATE negotiations
         SET state = ?, current_prompt = ?, awaiting_identity = ?, transcript = ?,
             question_id = ?, updated_at = ?
         WHERE id = ? AND state NOT IN ('accepted','declined','cancelled')`,
      )
      .run(state, question, awaiting, transcript, questionId, now, id);
  }

  /** Party or escalated person answers; returns to open so the pipeline re-runs. */
  async answer(id: string, answeredBy: string, answer: string): Promise<void> {
    const now = this.clock();
    const transcript = await this.append(id, {
      from: answeredBy,
      kind: "answer",
      content: answer,
      at: now,
    });
    const updated = await this.db
      .prepare(
        `UPDATE negotiations
         SET state = 'open', current_prompt = NULL, awaiting_identity = NULL,
             transcript = ?, updated_at = ?
         WHERE id = ? AND state IN ('awaiting_party','awaiting_person')`,
      )
      .run(transcript, now, id);
    if (updated.changes !== 1) {
      throw new Error(`negotiation ${id} was not awaiting an answer`);
    }
  }

  async finalize(id: string, state: "accepted" | "declined" | "cancelled"): Promise<void> {
    const updated = await this.db
      .prepare(
        `UPDATE negotiations
         SET state = ?, current_prompt = NULL, awaiting_identity = NULL, updated_at = ?
         WHERE id = ? AND state NOT IN ('accepted','declined','cancelled')`,
      )
      .run(state, this.clock(), id);
    if (updated.changes !== 1) {
      throw new Error(`negotiation ${id} is already terminal or missing`);
    }
  }

  /**
   * Cancel non-terminal negotiations whose updated_at is older than maxAgeMs.
   * Returns how many rows were cancelled.
   */
  async sweepStale(now: number, maxAgeMs: number): Promise<number> {
    const res = await this.db
      .prepare(
        `UPDATE negotiations
         SET state = 'cancelled', current_prompt = NULL, awaiting_identity = NULL, updated_at = ?
         WHERE state NOT IN ('accepted','declined','cancelled') AND updated_at < ?`,
      )
      .run(now, now - maxAgeMs);
    return res.changes;
  }
}
