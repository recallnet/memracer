import * as React from "react";
import { createPortal } from "react-dom";
import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = `tooltip-${useId().replaceAll(":", "")}`;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  if (!isValidElement(children)) return null;
  const show = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    const box = target.getBoundingClientRect();
    setPosition({ left: box.left + box.width / 2, top: box.top - 7 });
  };
  const child = cloneElement(children as ReactElement<Record<string, unknown>>, {
    "aria-describedby": position ? id : undefined,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => show(event.currentTarget),
    onMouseLeave: () => setPosition(null),
    onFocus: (event: React.FocusEvent<HTMLElement>) => show(event.currentTarget),
    onBlur: () => setPosition(null),
  });
  return <>{child}{position && createPortal(<span id={id} role="tooltip" className="ui-tooltip" style={{ left: position.left, top: position.top }}>{content}</span>, document.body)}</>;
}
