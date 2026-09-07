import * as React from "react";
import {
  AIR_GAP_SUMMARY,
  FAQ_SECTIONS,
  HOW_THIS_WORKS_LABEL,
  TRUST_SUMMARY,
} from "../../public/onboarding-copy.js";

export function MarketingFaq() {
  return (
    <div className="marketing-page marketing-faq-page">
      <header className="marketing-nav">
        <a className="marketing-brand" href="/">
          mem<span className="marketing-brand-accent">racer</span>
        </a>
        <nav className="marketing-nav-links" aria-label="FAQ">
          <a className="marketing-nav-link" href="/">
            Home
          </a>
          <a className="marketing-nav-cta" href="/#signup">
            Sign up
          </a>
          <a className="marketing-nav-link" href="/signin">
            Sign in
          </a>
        </nav>
      </header>

      <main>
        <section className="marketing-section" aria-labelledby="faq-heading">
          <p className="marketing-kicker">{HOW_THIS_WORKS_LABEL}</p>
          <h1 id="faq-heading" className="marketing-section-title">
            FAQ
          </h1>
          <p className="marketing-section-lead">
            Factory model in one page — seats, air-gaps, trust, agents, merge, and billing. No multi-page handbook.
          </p>
          <p className="marketing-section-lead">
            {TRUST_SUMMARY} {AIR_GAP_SUMMARY}
          </p>
          <nav className="marketing-faq-toc" aria-label="FAQ sections">
            <ul>
              {FAQ_SECTIONS.map((section) => (
                <li key={section.id}>
                  <a className="marketing-nav-link" href={`#${section.id}`}>
                    {section.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {FAQ_SECTIONS.map((section) => (
            <article
              key={section.id}
              className="marketing-faq-section"
              id={section.id}
              aria-labelledby={`faq-${section.id}-title`}
            >
              <h2 id={`faq-${section.id}-title`}>{section.title}</h2>
              <p>{section.body}</p>
            </article>
          ))}
        </section>
      </main>

      <footer className="marketing-footer">
        <span className="marketing-footer-brand">
          memracer
          <span className="marketing-footer-tag">Orchestration for the age of agents · a Recall project</span>
        </span>
        <a className="marketing-nav-link" href="/">
          Back to home
        </a>
      </footer>
    </div>
  );
}
