import { Check, ChevronDown } from "lucide-react";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";

export interface SelectOption { value: string; label: string }

export function Select({ value, defaultValue, onValueChange, options, ariaLabel, id, className, disabled }: {
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void; options: SelectOption[];
  ariaLabel: string; id?: string; className?: string; disabled?: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const selectedValue = value ?? internalValue;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
  const choose = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const move = (offset: number) => choose(options[(selectedIndex + offset + options.length) % options.length]?.value ?? selectedValue);
  return <span className="ui-select" ref={root}>
    <button id={id} type="button" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={`${id ?? ariaLabel}-options`} className={cn("ui-select-trigger", className)} disabled={disabled} onClick={() => setOpen((current) => !current)} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
      if (event.key === "Escape") setOpen(false);
    }}><span>{options[selectedIndex]?.label ?? selectedValue}</span><ChevronDown size={13} aria-hidden="true" /></button>
    {open && <span id={`${id ?? ariaLabel}-options`} className="ui-select-content" role="listbox" aria-label={ariaLabel}>{options.map((option) => <button type="button" role="option" aria-selected={option.value === selectedValue} className="ui-select-item" onClick={() => choose(option.value)} key={option.value}><span>{option.label}</span>{option.value === selectedValue && <Check size={13} aria-hidden="true" />}</button>)}</span>}
  </span>;
}
