import * as React from "react";
import {
  AIR_GAP_SUMMARY,
  TRUST_SUMMARY,
} from "../../public/onboarding-copy.js";
import { Card } from "./ui/card.js";

const HOW_STEPS = [
  {
    n: "01",
    tag: "SAY IT",
    title: "Submit intent",
    body: "One plain sentence. No tickets, no acceptance criteria, no ceremony. You describe the outcome you want.",
  },
  {
    n: "02",
    tag: "GROOM IT",
    title: "The mediator scopes",
    body: "Frigg interrogates the plan before a line is written — scope, edge cases, priority — and turns your sentence into a real, bounded task.",
  },
  {
    n: "03",
    tag: "BUILD IT",
    title: "Agents claim & ship",
    body: "A fleet of coding agents pulls the queue, writes the code, opens real PRs, and merges them green. In parallel.",
  },
  {
    n: "04",
    tag: "WATCH IT",
    title: "See every move",
    body: "A live timeline of every agent's reasoning, every decision, every PR, and every dollar — as it happens.",
  },
] as const;

const VALUE_CARDS = [
  {
    tag: "Direction, not diffs",
    title: "Stop wrangling prompts",
    body: "Frigg grills the plan and refuses hollow work. You stay at the altitude of intent.",
  },
  {
    tag: "Your keys",
    title: "BYOK, your control",
    body: "Your model, your spend, your data. We never meter your tokens.",
  },
  {
    tag: "The whole room",
    title: "Watch it all, live",
    body: "Every decision, merge, and cent of spend in one screen. Nothing off-camera.",
  },
  {
    tag: "Order from chaos",
    title: "A queue that runs itself",
    body: "Frigg scopes, splits, and sequences the work — a self-organizing backlog.",
  },
  {
    tag: "Cost, to the cent",
    title: "Know the spend, always",
    body: "Per-model, per-project spend, charted live. No surprise bills.",
  },
  {
    tag: "A fleet, not a to-do list",
    title: "Run parallel by default",
    body: "Ten agents, one direction — isolated worktrees, dependency-aware claims.",
  },
] as const;

const FIGURE_ROWS = [
  { chip: "QUEUED", tone: "queued", task: "geo-block restricted regions", who: "Frigg" },
  { chip: "EXECUTING", tone: "exec", task: "fix the flaky merge queue", who: "codex-home" },
  { chip: "PR ✓ MERGED", tone: "merged", task: "add desktop notifications", who: "claude-coder" },
] as const;

/** Fixed frame contract from `pnpm marketing:shots` (16:10). */
const FRAME_W = 1440;
const FRAME_H = 900;
const SHOT_BASE = "/dashboard/marketing/shots";

const PRODUCT_FEATURED = {
  file: "product-ops-1440x900.png",
  title: "One floor for the whole fleet",
  body: "Needs-you, multi-state queue, and live activity share one surface — so you steer intent without tab-hunting the room.",
} as const;

const PRODUCT_SECONDARY = [
  {
    file: "product-timeline-1440x900.png",
    title: "Every decision, as it happens",
    body: "Frigg’s reasoning, plan verdicts, and coder steps land in one timeline you can audit.",
  },
  {
    file: "product-analytics-1440x900.png",
    title: "Spend you can read",
    body: "Model cost and throughput stay charted live — per project, not a black-box burn.",
  },
] as const;

const PRODUCT_MCP = [
  {
    file: "mcp-human-1440x900.png",
    title: "Human MCP",
    body: "Status, answer needs-you, submit intent — from Claude Code.",
  },
  {
    file: "mcp-coder-1440x900.png",
    title: "Coder MCP",
    body: "Check work, claim, plan, complete with a real PR URL.",
  },
] as const;

const SHIFT_ROWS = [
  { label: "You bring", value: "A sentence, and your model key." },
  { label: "Frigg brings", value: "Scope, questions, priority, review." },
  { label: "The fleet brings", value: "Real PRs, merged green, in parallel." },
  { label: "You keep", value: "The keys, the data, the spend, the timeline." },
] as const;

function modelLine(plan: "solo" | "team"): string {
  if (plan === "solo") return "BYOK — your key, your spend";
  return "BYOK — your keys, per-project spend walls";
}

/** Hero figure: a compact live-Operations panel in the product's own dark UI
    language — intent queued, executing, merged — so the hero shows the app. */
function HeroFigure() {
  return (
    <div className="marketing-figure" aria-hidden="true">
      <div className="mf-window">
        <div className="mf-bar">
          <span className="mf-bar-title">Operations · Signal Raceway</span>
          <span className="mf-live">
            <span className="mf-live-dot" />
            live
          </span>
        </div>
        <div className="mf-rows">
          {FIGURE_ROWS.map((row, i) => (
            <div
              key={row.task}
              className={`mf-row mf-row-${row.tone}`}
              style={{ animationDelay: `${i * 0.9}s` }}
            >
              <span className={`mf-chip mf-chip-${row.tone}`}>{row.chip}</span>
              <span className="mf-task">{row.task}</span>
              <span className="mf-who">{row.who}</span>
            </div>
          ))}
        </div>
        <div className="mf-foot">
          <span className="mf-foot-frigg">Frigg</span>
          <span className="mf-foot-text">scopes · prioritizes · reviews every plan</span>
        </div>
      </div>
    </div>
  );
}

export function MarketingHome() {


  return (
    <div className="marketing-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/">
          mem<span className="marketing-brand-accent">racer</span>
        </a>
        <nav className="marketing-nav-links" aria-label="Page">
          <a className="marketing-nav-link" href="#how">
            How it works
          </a>
          <a className="marketing-nav-link" href="#frigg">
            Meet Frigg
          </a>
          <a className="marketing-nav-link" href="#why">
            Why it wins
          </a>
          <a className="marketing-nav-link" href="#agents">
            Agents
          </a>
          <a className="marketing-nav-link" href="#pricing">
            Pricing
          </a>
          <a className="marketing-nav-cta" href="/signin">
            Get started
          </a>
          <a className="marketing-nav-link" href="/signin">
            Sign in
          </a>
        </nav>
      </header>

      <main>
        <section className="marketing-hero">
          <div className="marketing-hero-copy">
            <p className="marketing-kicker">Your coding cloud, coordinated</p>
            <h1 className="marketing-hero-title">
              Describe what you want.{" "}
              <span className="marketing-hero-emphasis">Watch it ship.</span>
            </h1>
            <p className="marketing-hero-lead">
              Run a fleet of coding agents on your own machines, your own subscription plans, your
              own repos. Frigg scopes the work, keeps the agents from colliding, and lands it — you
              watch every move in a live timeline. Your cloud. Your keys.
            </p>
            <div className="marketing-hero-ctas">
              <a className="marketing-btn-primary" href="/signin">
                Get started →
              </a>
              <a className="marketing-btn-ghost" href="#how">
                See how it works
              </a>
            </div>
            <p className="marketing-hero-note">
              BYOK by default · your keys, your data, your spend
            </p>
          </div>
          <HeroFigure />
        </section>

        <section className="marketing-section" id="problem" aria-labelledby="problem-heading">
          <p className="marketing-eyebrow">The problem</p>
          <h2 id="problem-heading" className="marketing-section-title">
            One agent is a demo. A fleet is chaos.
          </h2>
          <p className="marketing-section-lead">
            Ten agents in one repo overwrite each other&apos;s files, and you become the bottleneck
            reviewing the pile. GitHub was built for a few humans opening a few PRs a day — not a
            fleet. memracer is the coordination layer it never gave you.
          </p>
        </section>

        <section className="marketing-section" id="how" aria-labelledby="how-heading">
          <p className="marketing-eyebrow">How it works</p>
          <h2 id="how-heading" className="marketing-section-title">
            Intent in. Shipped software out.
          </h2>
          <ol className="marketing-flow">
            {HOW_STEPS.map((step) => (
              <li key={step.n}>
                <span className="marketing-flow-n">
                  {step.n} — {step.tag}
                </span>
                <strong>{step.title}</strong>
                <span>{step.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="marketing-section marketing-frigg" id="frigg" aria-labelledby="frigg-heading">
          <p className="marketing-eyebrow">Meet Frigg</p>
          <h2 id="frigg-heading" className="marketing-section-title">
            The mediator who runs the room.
          </h2>
          <p className="marketing-section-lead">
            Frigg is memracer&apos;s orchestrator — the agent that turns a sentence of intent into
            scoped work the fleet can ship.
          </p>
          <div className="marketing-frigg-grid">
            <article className="marketing-frigg-card">
              <p className="marketing-value-tag">Who</p>
              <h3>Frigg, the mediator</h3>
              <p>
                One persistent agent that owns judgment for your project — not a chat session that
                forgets, and not a free-for-all of unmediated coders.
              </p>
            </article>
            <article className="marketing-frigg-card">
              <p className="marketing-value-tag">What she does</p>
              <h3>Groom, prioritize, approve</h3>
              <p>
                She interrogates intent, splits work, ranks the queue, and reviews coder plans
                before anything lands as a PR.
              </p>
            </article>
            <article className="marketing-frigg-card">
              <p className="marketing-value-tag">Why she matters</p>
              <h3>Judgment is the product</h3>
              <p>
                Speed without mediation is thrash. Frigg is the barrier that keeps hollow and
                mis-scoped work off the floor.
              </p>
            </article>
            <article className="marketing-frigg-card">
              <p className="marketing-value-tag">How you work with her</p>
              <h3>Daily, at the altitude of intent</h3>
              <p>
                You submit outcomes, answer needs-you when she escalates, and watch the live
                timeline — she keeps the fleet moving between those moments.
              </p>
            </article>
          </div>
        </section>

        <section className="marketing-section" id="product" aria-labelledby="product-heading">
          <p className="marketing-eyebrow">Product</p>
          <h2 id="product-heading" className="marketing-section-title">
            The factory floor, live.
          </h2>
          <p className="marketing-section-lead">
            Humans, Frigg, and the coder fleet share one operational dashboard — queue, attention,
            timeline, and spend — as the work moves.
          </p>

          <article className="marketing-product-featured">
            <div className="marketing-product-frame">
              <img
                src={`${SHOT_BASE}/${PRODUCT_FEATURED.file}`}
                alt={PRODUCT_FEATURED.title}
                width={FRAME_W}
                height={FRAME_H}
                loading="lazy"
                decoding="async"
              />
            </div>
            <div className="marketing-product-copy">
              <h3>{PRODUCT_FEATURED.title}</h3>
              <p>{PRODUCT_FEATURED.body}</p>
            </div>
          </article>

          <div className="marketing-product-secondary">
            {PRODUCT_SECONDARY.map((moment) => (
              <article key={moment.file} className="marketing-product-card">
                <div className="marketing-product-frame">
                  <img
                    src={`${SHOT_BASE}/${moment.file}`}
                    alt={moment.title}
                    width={FRAME_W}
                    height={FRAME_H}
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <div className="marketing-product-copy">
                  <h3>{moment.title}</h3>
                  <p>{moment.body}</p>
                </div>
              </article>
            ))}
          </div>

          <div className="marketing-product-mcp-band">
            <p className="marketing-eyebrow">How you work</p>
            <div className="marketing-product-mcp-grid">
              {PRODUCT_MCP.map((moment) => (
                <article key={moment.file} className="marketing-product-card marketing-product-mcp">
                  <div className="marketing-product-frame">
                    <img
                      src={`${SHOT_BASE}/${moment.file}`}
                      alt={moment.title}
                      width={FRAME_W}
                      height={FRAME_H}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <div className="marketing-product-copy">
                    <h3>{moment.title}</h3>
                    <p>{moment.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="marketing-section" id="why" aria-labelledby="why-heading">
          <h2 id="why-heading" className="marketing-section-title">
            You approve intent, not diffs.
          </h2>
          <p className="marketing-section-lead">
            The best builders don&apos;t babysit agents. They set direction and watch the room
            move. memracer is built around how you actually want to work.
          </p>
          <div className="marketing-value-grid">
            {VALUE_CARDS.map((card) => (
              <Card key={card.title} className="marketing-value-card">
                <p className="marketing-value-tag">{card.tag}</p>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
              </Card>
            ))}
          </div>
        </section>

        <section className="marketing-quote-band" aria-labelledby="quote-heading">
          <blockquote id="quote-heading" className="marketing-quote">
            The people who win with AI won&apos;t be the ones typing prompts. They&apos;ll be the
            ones orchestrating a room.
          </blockquote>
          <p className="marketing-quote-cite">— what building with memracer feels like</p>
          <dl className="marketing-shift">
            {SHIFT_ROWS.map((row) => (
              <div key={row.label} className="marketing-shift-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="marketing-section" id="agents" aria-labelledby="agents-heading">
          <p className="marketing-eyebrow">Agents</p>
          <h2 id="agents-heading" className="marketing-section-title">
            First-class across the harnesses you already use.
          </h2>
          <p className="marketing-section-lead">
            Install the memracer CLI and run <code>memracer enroll</code>. One command connects every harness.
          </p>
          <ul className="marketing-agents-grid" aria-label="Supported coding agents">
            {[
              { id: "claude-code", name: "Claude Code", file: "claude.svg", url: "https://claude.com/claude-code", invert: false },
              { id: "codex", name: "Codex", file: "openai.svg", url: "https://openai.com/codex", invert: false },
              { id: "antigravity", name: "Antigravity", file: "antigravity.png", url: "https://antigravity.google", invert: false },
              { id: "opencode", name: "OpenCode", file: "opencode.svg", url: "https://opencode.ai", invert: false },
              { id: "forge", name: "Forge", file: "forge.svg", url: "https://forgecode.dev", invert: false },
              { id: "goose", name: "Goose", file: "goose.png", url: "https://block.github.io/goose", invert: true },
            ].map((agent) => (
              <li key={agent.id} className="marketing-agent-card">
                <a
                  className="marketing-agent-link"
                  href={agent.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    className={`marketing-agent-logo${agent.invert ? " is-invert" : ""}`}
                    src={`/dashboard/marketing/logos/${agent.file}`}
                    alt=""
                    width={22}
                    height={22}
                    loading="lazy"
                  />
                  <span className="marketing-agent-name">{agent.name}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="marketing-section" id="byo" aria-labelledby="byo-heading">
          <h2 id="byo-heading" className="marketing-section-title">
            Bring your own coding cloud.
          </h2>
          <p className="marketing-section-lead">
            Your machines. Your Max plans. Your repos. memracer is the queue, the mediator, and the
            shared timeline that turns them into one coordinated fleet — not a sandbox you rent. You
            own the host and the keys; we run the room.
          </p>
          <p className="marketing-section-lead">
            {AIR_GAP_SUMMARY} {TRUST_SUMMARY}
          </p>
          <p className="marketing-section-lead">
            <a href="/faq#trust">Trust model</a>
            {" · "}
            <a href="/faq#agents">Agents &amp; harnesses</a>
            {" · "}
            <a href="/faq">Full FAQ</a>
          </p>
        </section>

        <section className="marketing-section" id="pricing" aria-labelledby="pricing-heading">
          <h2 id="pricing-heading" className="marketing-section-title">
            Pay for the orchestration. Not the tokens.
          </h2>
          <p className="marketing-section-lead">
            Bring your own model key and you pay only for the mediator and the fleet — a flat seat
            price, nothing between you and your provider. Keys stay in your org; spend limits live
            where they belong — your OpenRouter, OpenAI, or xAI dashboard.
          </p>

          <div className="marketing-pricing-grid">
            <Card className="marketing-plan-card">
              <h3>Solo</h3>
              <p className="marketing-plan-price">
                $5 <span className="marketing-plan-unit">/ seat / mo</span>
              </p>
              <p>For a builder and a small crew moving fast.</p>
              <ul className="marketing-plan-list">
                <li>Up to 15 seats</li>
                <li>5 projects</li>
                <li>Full mediator + fleet</li>
                <li>Live timeline &amp; spend</li>
                <li className="marketing-plan-model">{modelLine("solo")}</li>
              </ul>
              <a className="marketing-plan-cta" href="/signin">
                Get started
              </a>
            </Card>

            <Card className="marketing-plan-card marketing-plan-featured">
              <p className="marketing-plan-badge">Most teams</p>
              <h3>Team</h3>
              <p className="marketing-plan-price">
                $29 <span className="marketing-plan-unit">/ seat / mo</span>
              </p>
              <p>For teams running a real fleet against a real roadmap.</p>
              <ul className="marketing-plan-list">
                <li>Up to 100 seats</li>
                <li>25 projects</li>
                <li>Roles, team analytics, attribution</li>
                <li>Priority orchestration</li>
                <li className="marketing-plan-model">{modelLine("team")}</li>
              </ul>
              <a className="marketing-plan-cta" href="/signin">
                Get started
              </a>
            </Card>

            <Card className="marketing-plan-card">
              <h3>Enterprise</h3>
              <p className="marketing-plan-price marketing-plan-price-talk">Let&apos;s talk</p>
              <p>No limits — fleet at company scale.</p>
              <ul className="marketing-plan-list">
                <li>Unlimited seats &amp; projects</li>
                <li>SSO, audit, self-host</li>
                <li>Dedicated support</li>
                <li>Custom routing</li>
              </ul>
              <a className="marketing-plan-cta" href="mailto:hello@memracer.com">
                Contact us
              </a>
            </Card>
          </div>
          <p className="marketing-pricing-footnote">
            Bring your own model key. You pay your provider directly — we never meter tokens.
          </p>
        </section>

        <section className="marketing-section marketing-waitlist-section" id="signup" aria-labelledby="signup-heading">
          <h2 id="signup-heading" className="marketing-section-title">
            Start running a fleet.
          </h2>
          <p className="marketing-section-lead">
            Sign in with your email, connect your agents, and pay when you&apos;re ready to run the
            fleet. Your machines, your keys.
          </p>
          <div className="marketing-hero-ctas">
            <a className="marketing-btn-primary" href="/signin">
              Get started →
            </a>
          </div>
        </section>
      </main>

      <footer className="marketing-footer">
        <span className="marketing-footer-brand">
          memracer
          <span className="marketing-footer-tag">
            Orchestration for the age of agents · a Recall project
          </span>
        </span>
        <a href="/signin">Sign in</a>
      </footer>
    </div>
  );
}
