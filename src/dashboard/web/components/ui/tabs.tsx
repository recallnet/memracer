import * as React from "react";
import { useState, type ReactNode } from "react";

export interface CountTab { id: string; label: string; count: number; content: ReactNode }

export function Tabs({ items, selected, onSelect }: { items: CountTab[]; selected?: number; onSelect?: (index: number) => void }) {
  const [internalIndex, setInternalIndex] = useState(0);
  const activeIndex = selected ?? internalIndex;
  const select = (index: number) => { if (selected === undefined) setInternalIndex(index); onSelect?.(index); };
  return <div className="ui-tabs">
    <div className="ui-tab-list" role="tablist">{items.map((item, index) => <button id={`tab-${item.id}`} type="button" role="tab" aria-selected={index === activeIndex} aria-controls={`panel-${item.id}`} className={index === activeIndex ? "ui-tab is-selected" : "ui-tab"} onClick={() => select(index)} key={item.id}>{item.label}<span>{item.count}</span></button>)}</div>
    {items.map((item, index) => <div id={`panel-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`} className={index === activeIndex ? "ui-tab-panel is-selected" : "ui-tab-panel"} hidden={index !== activeIndex} key={item.id}>{item.content}</div>)}
  </div>;
}
