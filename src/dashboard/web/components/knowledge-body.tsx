import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMemoryBody } from "../../../mediator/memory-body.js";
import type { MarkdownLinkTargetDto } from "../data/dto.js";

const MARKDOWN_HREF = /\.md(?:[?#]|$)/i;

export function KnowledgeBody({ body, linkTargets, onConcept }: {
  body: string;
  linkTargets: MarkdownLinkTargetDto[];
  onConcept: (path: string) => void;
}) {
  const resolved = new Map(linkTargets.map((link) => [link.href, link.path]));
  const normalizedBody = normalizeMemoryBody(body);
  return (
    <div className="knowledge-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href && MARKDOWN_HREF.test(href)) {
              const path = resolved.get(href);
              return path
                ? <button type="button" data-concept-path={path} onClick={() => onConcept(path)}>{children}</button>
                : <>{children}</>;
            }
            const external = href ? /^https?:\/\//i.test(href) : false;
            return <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
          },
        }}
      >
        {normalizedBody}
      </ReactMarkdown>
    </div>
  );
}
