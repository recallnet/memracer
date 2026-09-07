import { AlertTriangle, Inbox, LoaderCircle } from "lucide-react";
import * as React from "react";
import type { ReactNode } from "react";
import { Button } from "./button.js";

export type QueryView = "error" | "loading" | "empty" | "ready";

export function resolveQueryView({ error, pending, empty }: { error: boolean; pending: boolean; empty: boolean }): QueryView {
  if (error) return "error";
  if (pending) return "loading";
  if (empty) return "empty";
  return "ready";
}

export function LoadingState({ label, className = "empty-copy" }: { label: string; className?: string }) {
  return <div className={className} role="status" data-query-view="loading"><LoaderCircle size={16} aria-hidden="true" /><span>{label}</span></div>;
}

export function EmptyState({ label, className = "empty-copy" }: { label: string; className?: string }) {
  return <div className={className} data-query-view="empty"><Inbox size={16} aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorState({ heading, label, retry, stale = false, className = "surface-error query-notice" }: { heading?: string; label: string; retry?: () => void; stale?: boolean; className?: string }) {
  return <div className={className} role="alert" data-query-view="error"><span><AlertTriangle size={16} aria-hidden="true" /><span>{heading && <strong>{heading}</strong>}{label}{stale ? " Showing the last update." : ""}</span></span>{retry && <Button size="sm" onClick={retry}>Retry</Button>}</div>;
}

export function QueryViewState({ view, loading, empty, error, retry, children }: { view: QueryView; loading: string; empty: string; error: string; retry?: () => void; children: ReactNode }) {
  if (view === "error") return <ErrorState label={error} retry={retry} />;
  if (view === "loading") return <LoadingState label={loading} />;
  if (view === "empty") return <EmptyState label={empty} />;
  return children;
}
