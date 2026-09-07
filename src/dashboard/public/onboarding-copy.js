/*
 * Shared onboarding / FAQ copy for lander, Get started, Settings, and /faq.
 * Keep browser-safe (no Node APIs). Import from dashboard components and tests.
 */

export const FAQ_SECTIONS = [
  {
    id: "what",
    title: "What is memracer?",
    body:
      "memracer is a collaborative software factory: humans submit outcomes through MCP, Frigg (the mediator) grooms them into a queue, and coding agents on your machines claim and ship PRs. There is no separate docs portal — this FAQ is the teaching surface.",
  },
  {
    id: "roles",
    title: "Human seats and coder seats",
    body:
      "A factory needs at least one human seat and one coder seat. Humans shape work (submit, discuss, answer). Coders claim tasks, propose plans, implement, and complete with a PR. A seat is one connected human or coder: an admin generates a role-scoped onboarding prompt in Settings → Seats, then the teammate or agent installs the memracer CLI and runs `memracer enroll` to connect it. Dashboard login alone does not count as a seat.",
  },
  {
    id: "setup",
    title: "Setup and air-gaps",
    body:
      "Keep human and coder workspaces separate so a coding agent cannot silently rewrite the human session. Three valid patterns: (1) two machines; (2) same machine, two folders or worktrees enrolled with different tokens; (3) coder running in a container. Generate separate human and coder onboarding prompts in Settings → Seats and enroll each in its own workspace.",
  },
  {
    id: "trust",
    title: "Trust model",
    body:
      "Any project human can submit work that any project coder will run. memracer is not host isolation: the coder harness executes on machines you control. Treat tokens as secrets, refuse malicious task outcomes, and keep air-gaps as above. You approve intent through Frigg; you still own the host and the git remote.",
  },
  {
    id: "agents",
    title: "Bring your own coders",
    body:
      "Connect Claude Code, Claude Desktop, Codex, Pi, Cursor, Grok, or any harness the memracer CLI supports. Generate a coder onboarding prompt in Settings → Seats, install the CLI, and run `memracer enroll` — the CLI writes the harness config for you. Agents drain the same queue; harness choice is yours.",
  },
  {
    id: "merge",
    title: "Merge patterns",
    body:
      "Merge queue and auto-merge are optional. Leaving auto-merge off is fine. A human agent reviewing and approving PRs is a valid pattern. DONE means the PR is merged with green required checks; open or red PRs sit in AWAITING_MERGE until they land.",
  },
  {
    id: "billing",
    title: "Billing",
    body:
      "Org seat plans (Solo / Team) unlock invites, extra projects, and Frigg. BYOK: put your model key in Org settings so Frigg and mediation use your provider spend. See pricing on the lander and Org settings for checkout.",
  },
];

export const AIR_GAP_SUMMARY =
  "Three air-gaps: two machines; same machine with two folders/worktrees and different tokens; or coder in a container.";

export const TRUST_SUMMARY =
  "Any project human can submit work any project coder will run. memracer is not host isolation — you own the host and the keys.";

export const TOKEN_SCOPE_NOTE =
  "Each seat is scoped to one project and one role (human or coder). Treat its enrollment token like a password; never commit it. Enroll a human seat for submit/status and a coder seat for claim/complete.";

export const GET_STARTED_TITLE = "Get started: seed the factory";

export const GET_STARTED_BODY =
  "Generate a human and a coder onboarding prompt in Settings → Seats, run `memracer enroll` for each in its own workspace, and keep an air-gap between them. Frigg grooms human submissions; coders drain the queue.";

export const GET_STARTED_STEPS = [
  "Open Settings → Seats and generate an onboarding prompt for a human seat and a coder seat.",
  "Give each prompt to the teammate or agent who runs that seat — they run `memracer enroll <token>` to connect it.",
  AIR_GAP_SUMMARY,
  "Set up billing — seats connect free, but Frigg only starts grooming once billing is active (Org Settings → Checkout).",
  "Read How this works for trust and merge patterns.",
];

export const BILLING_GATE_TITLE = "Seats connected — set up billing to start Frigg";

export const BILLING_GATE_BODY =
  "Your human and coder seats are connected. Frigg only starts grooming submissions once billing is active. Set up billing in Org Settings to put the factory to work — seats stay free, you pay your model provider directly.";

export const BILLING_GATE_CTA = "Set up billing";

export const SEAT_EMPTY_BANNER =
  "No seats connected yet. Generate a human onboarding prompt (submit work) and a coder onboarding prompt (claim work), then run `memracer enroll` for each so the factory can run.";

export const SEAT_PARTIAL_BANNER =
  "Factory readiness needs both seat types: at least one connected human seat and one connected coder seat.";

export const HOW_THIS_WORKS_LABEL = "How this works";

export const HOW_THIS_WORKS_HREF = "/faq";

export const BYO_BAND_TITLE = "Bring your own coders";

export const BYO_BAND_BODY =
  "You bring the agents. memracer is the queue, Frigg, and the shared timeline — not a hosted coding sandbox.";

export const INVITE_ROLE_HELP =
  "Invite humans to submit and answer; invite coders so their agents can claim. Admins manage access and seats.";
