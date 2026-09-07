import * as Dialog from "@radix-ui/react-dialog";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, BarChart3, BookOpen, Building2, Check, Copy, FileText, FolderGit2, FolderPlus, FolderTree, Gauge, GitBranch, History, KeyRound, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { dashboardApi } from "../data/api.js";
import type { AnalyticsContributionCountsDto, AnalyticsDto, AnalyticsPeriod, KnowledgeActivityDto, KnowledgeTaskRefDto, MembershipDto } from "../data/dto.js";
import { queryKeys } from "../data/query-keys.js";
import { formatUsd } from "../lib/format-usd.js";
import { compareScorecardModels, modelFamily } from "../../model-family.js";
import { KnowledgeTree } from "./knowledge-tree.js";
import { KnowledgeBody } from "./knowledge-body.js";
import { Badge } from "./ui/badge.js";
import { Avatar } from "./ui/avatar.js";
import { Button } from "./ui/button.js";
import { Card, SidebarSection } from "./ui/card.js";
import { Select } from "./ui/select.js";
import { EmptyState, ErrorState, LoadingState, resolveQueryView } from "./ui/state.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";
import { Tooltip } from "./ui/tooltip.js";
import {
  HOW_THIS_WORKS_HREF,
  HOW_THIS_WORKS_LABEL,
  INVITE_ROLE_HELP,
} from "../../public/onboarding-copy.js";

// Roles the Seats panel mints a one-paste onboarding prompt for. Hardcoded to
// the two built-in roles; custom roles can still be enrolled via the API
// (POST /api/p/:project/enrollments with any role slug).
const ROSTER_ROLES = ["human", "coder"] as const;

function CopyAction({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const run = async () => {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };
  return <Button type="button" onClick={() => void run()}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : label}</Button>;
}

function repositoryUrl(repo: string | null): string | null {
  if (!repo) return null;
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
    return null;
  }
  return `https://github.com/${parts.map(encodeURIComponent).join("/")}`;
}

export function GitHubConnectionPanel({
  membership,
  scope = "project",
}: {
  membership: MembershipDto;
  /** Org Settings uses org-scoped chrome; Project settings keep project wording. */
  scope?: "project" | "org";
}) {
  const org = membership.orgId;
  const connection = useQuery({
    queryKey: queryKeys.githubConnection(org ?? ""),
    queryFn: () => dashboardApi.githubConnection(org!),
    enabled: Boolean(org),
    retry: false,
  });
  const link = useMutation({
    mutationFn: () => dashboardApi.linkGitHub(window.location.href),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const install = useMutation({
    mutationFn: () => dashboardApi.startGitHubInstall(org!, `${window.location.pathname}${window.location.search}`),
    onSuccess: ({ installUrl }) => window.location.assign(installUrl),
  });
  const repoUrl = repositoryUrl(membership.repo);

  return <section className="github-connection-panel" aria-labelledby="github-connection-heading" data-github-scope={scope}>
    <header className="admin-section-heading"><div><h2 id="github-connection-heading">GitHub connection</h2><p>{scope === "org" ? "Org installation and repository access for projects in this organization." : "Repository access for this Project (via its Org installation)."}</p></div><GitBranch size={18} /></header>
    <div className={`github-connection-grid${scope === "org" ? " github-connection-grid-org" : ""}`}>
      <div className="github-connection-state" role="status">
        {!org ? <><span><Badge variant="neutral">Unavailable</Badge><b>No Org assigned</b></span><p>Assign this Project to an Org before connecting GitHub.</p></>
          : connection.isPending ? <LoadingState label="Loading GitHub connection…" />
            : connection.isError ? <><ErrorState label="GitHub connection unavailable." retry={() => void connection.refetch()} /><p>If GitHub says your credentials expired, reconnect your identity.</p><Button type="button" disabled={link.isPending} onClick={() => link.mutate()}><GitBranch size={14} />Reconnect GitHub</Button></>
              : !connection.data?.configured ? <><span><Badge variant="warning">Not configured</Badge><b>Deployment setup required</b></span><p>Set <code>MEMRACER_GITHUB_APP_SLUG</code>, <code>MEMRACER_GITHUB_APP_CLIENT_ID</code>, and <code>MEMRACER_GITHUB_APP_CLIENT_SECRET</code>, then restart memracer. Follow <code>docs/github-app.md</code>.</p></>
                : !connection.data.linked ? <><span><Badge variant="warning">{connection.data.reauthRequired || connection.data.installation ? "Reconnect required" : "Link required"}</Badge><b>GitHub identity</b></span><p>{connection.data.reauthRequired || connection.data.installation ? "Your GitHub link expired or could not be refreshed. Reconnect to restore Org installation access." : "Link your signed-in account before installing the Org's GitHub App."}</p><Button type="button" disabled={link.isPending} onClick={() => link.mutate()}><GitBranch size={14} />{connection.data.reauthRequired || connection.data.installation ? "Reconnect GitHub" : "Link GitHub"}</Button></>
                  : !connection.data.installation ? <><span><Badge variant="warning">Install required</Badge><b>GitHub App</b></span><p>Install the App with access to all repositories or only selected repositories.</p><Button type="button" disabled={install.isPending} onClick={() => install.mutate()}><GitBranch size={14} />Install GitHub App</Button></>
                    : <><span><Badge variant="success">Connected</Badge><b>{connection.data.installation.accountLogin}</b></span><p>{connection.data.installation.repositorySelection === "all" ? "All repositories available to this installation." : connection.data.repositories.length === 0 ? "The installation has no selected repositories available." : `${connection.data.repositories.length} selected ${connection.data.repositories.length === 1 ? "repository" : "repositories"} available.`}</p></>}
        {(link.isError || install.isError) && <p role="alert">{String(link.error ?? install.error)}</p>}
      </div>
      {scope === "project" ? (
        <div className="project-repository">
          <span><FolderGit2 size={14} /><b>Project repository</b></span>
          {repoUrl ? <a href={repoUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${membership.repo} on GitHub`}><FolderGit2 size={14} />{membership.repo}</a> : <p>{membership.repo ? `Invalid repository: ${membership.repo}` : "No repository assigned."}</p>}
        </div>
      ) : null}
    </div>
  </section>;
}

function GitHubProjectCreator({ org, onCreated }: { org: string; onCreated: (project: string, warning?: string) => void }) {
  const client = useQueryClient();
  const connection = useQuery({
    queryKey: queryKeys.githubConnection(org),
    queryFn: () => dashboardApi.githubConnection(org),
    retry: false,
  });
  const [name, setName] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const link = useMutation({
    mutationFn: () => dashboardApi.linkGitHub(window.location.href),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  const install = useMutation({
    mutationFn: () => dashboardApi.startGitHubInstall(org, `${window.location.pathname}${window.location.search}`),
    onSuccess: ({ installUrl }) => window.location.assign(installUrl),
  });
  const create = useMutation({
    mutationFn: () => dashboardApi.createGitHubProject(org, name.trim(), repositoryId),
    onSuccess: (project) => {
      setName("");
      setRepositoryId("");
      void client.invalidateQueries({ queryKey: queryKeys.githubConnection(org) });
      onCreated(project.id, project.warning);
    },
  });
  const error = connection.error ?? link.error ?? install.error ?? create.error;

  return <section className="github-project-create" aria-labelledby={`github-project-${org}`}>
    <header><div><h3 id={`github-project-${org}`}>GitHub repository</h3><p>{connection.data?.installation ? `Connected to ${connection.data.installation.accountLogin}` : "Create from GitHub App access."}</p></div><GitBranch size={18} /></header>
    {connection.isPending ? <LoadingState label="Loading GitHub connection…" />
      : connection.isError ? <ErrorState label="GitHub connection unavailable." retry={() => void connection.refetch()} />
        : !connection.data?.configured ? <EmptyState label="GitHub App is not configured. See the GitHub connection section above." />
          : !connection.data.linked ? <Button type="button" disabled={link.isPending} onClick={() => link.mutate()}><GitBranch size={14} />Link GitHub</Button>
            : !connection.data.installation ? <Button type="button" disabled={install.isPending} onClick={() => install.mutate()}><GitBranch size={14} />Install GitHub App</Button>
              : connection.data.repositories.length === 0 ? <EmptyState label={connection.data.installation.repositorySelection === "all" ? "No repositories available." : "No selected repositories available."} />
                : <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && repositoryId) create.mutate(); }}>
                    <label>Project name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
                    <label>Repository<Select ariaLabel="GitHub repository" value={repositoryId} onValueChange={setRepositoryId} options={connection.data.repositories.map((repository) => ({ value: repository.id, label: repository.fullName }))} /></label>
                    <Button disabled={create.isPending || !repositoryId}><FolderGit2 size={14} />Create from GitHub</Button>
                  </form>}
    {error && !connection.isError && <p role="alert">{String(error)}</p>}
  </section>;
}

/** Single project-create flow: manual name/repo + optional GitHub. Shared by New menu and onboarding. */
function CreateProjectForm({
  orgId,
  onCreated,
  onError,
  onWarning,
  projectNameRef,
  footer,
  submitLabel = "Create Project",
  usePlainButton = false,
}: {
  orgId: string;
  onCreated: (project: string, warning?: string) => void;
  onError?: (message: string) => void;
  onWarning?: (message: string) => void;
  projectNameRef?: React.RefObject<HTMLInputElement | null>;
  footer?: React.ReactNode;
  submitLabel?: string;
  usePlainButton?: boolean;
}) {
  const [projectName, setProjectName] = useState("");
  const [repo, setRepo] = useState("");
  const createProject = useMutation({
    mutationFn: () => dashboardApi.createProject(orgId, projectName.trim(), repo.trim()),
    onSuccess: (value) => {
      setProjectName("");
      setRepo("");
      onCreated(value.id, value.warning);
    },
    onError: (value) => onError?.(String(value)),
  });
  const Submit = usePlainButton
    ? <button disabled={createProject.isPending}>{submitLabel}</button>
    : <Button disabled={createProject.isPending}><FolderPlus size={13} />{submitLabel}</Button>;
  return (
    <div className="create-project-form">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onWarning?.("");
          if (projectName.trim()) createProject.mutate();
        }}
      >
        <h3>New Project</h3>
        <label>Project name<input ref={projectNameRef as React.RefObject<HTMLInputElement>} required value={projectName} onChange={(event) => { setProjectName(event.target.value); onWarning?.(""); }} /></label>
        <label>Repository<input placeholder="owner/name (optional)" value={repo} onChange={(event) => { setRepo(event.target.value); onWarning?.(""); }} /></label>
        <p className="scope-copy">A coder needs a connected repo to open PRs. Add one now as <code>owner/name</code>, or create from the GitHub App on the right — without a repo, coders have nowhere to ship.</p>
        {Submit}
        {footer}
      </form>
      <GitHubProjectCreator
        org={orgId}
        onCreated={(project, nextWarning) => {
          onWarning?.(nextWarning ?? "");
          onCreated(project, nextWarning);
        }}
      />
    </div>
  );
}

export function ProjectCreationMenu({ membership, onCreated }: { membership: MembershipDto; onCreated: (project: string, warning?: string) => void }) {
  const [createdOrg, setCreatedOrg] = useState<{ id: string; name: string } | null>(null);
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const projectOrg = createdOrg?.id ?? membership.orgId;
  const createOrg = useMutation({ mutationFn: () => dashboardApi.createOrg(orgName.trim()), onSuccess: (value) => { setCreatedOrg({ id: value.id, name: value.name }); setOrgName(""); setError(""); setWarning(value.warning ?? ""); }, onError: (value) => setError(String(value)) });
  return <details className="project-create-menu"><summary><FolderPlus size={13} />New</summary><div className="project-create-popover"><h2>Create Project or Org</h2><p>{createdOrg ? `Create in new Org · ${createdOrg.name}.` : membership.orgId ? `Create in Org · ${membership.orgName ?? membership.orgId}.` : "Create an Org first."}</p>{warning && <p className="create-warning" role="status">{warning}</p>}{projectOrg && <CreateProjectForm orgId={projectOrg} onCreated={(project, nextWarning) => { setCreatedOrg(null); setError(""); setWarning(nextWarning ?? ""); onCreated(project, nextWarning); }} onError={setError} onWarning={setWarning} />}<form onSubmit={(event) => { event.preventDefault(); setWarning(""); if (orgName.trim()) createOrg.mutate(); }}><h3>New Org</h3><label>Org name<input required value={orgName} onChange={(event) => { setOrgName(event.target.value); setWarning(""); }} /></label><Button disabled={createOrg.isPending}><Building2 size={13} />Create Org</Button></form>{error && <p role="alert">{error}</p>}</div></details>;
}

export function Onboarding({ onCreated }: { onCreated: (project: string, warning?: string) => void }) {
  const [step, setStep] = useState<"org" | "project">("org");
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState<string | null>(null);
  const [warning, setWarning] = useState("");
  const [orgWarning, setOrgWarning] = useState("");
  const [error, setError] = useState("");
  const orgField = useRef<HTMLInputElement>(null);
  const projectField = useRef<HTMLInputElement>(null);
  useEffect(() => (step === "org" ? orgField : projectField).current?.focus(), [step]);
  useEffect(() => {
    const saved = window.sessionStorage.getItem("memracer:onboarding-org");
    if (!saved) return;
    try {
      const org = JSON.parse(saved) as { id?: string; name?: string };
      if (org.id && org.name) { setOrgId(org.id); setOrgName(org.name); setStep("project"); }
    } catch { window.sessionStorage.removeItem("memracer:onboarding-org"); }
  }, []);
  const finish = (project: string, createdWarning?: string) => {
    window.sessionStorage.removeItem("memracer:onboarding-org");
    onCreated(project, createdWarning ?? orgWarning);
  };
  const createOrg = useMutation({ mutationFn: () => dashboardApi.createOrg(orgName.trim()), onSuccess: (org) => { setOrgId(org.id); setWarning(org.warning ?? ""); setOrgWarning(org.warning ?? ""); window.sessionStorage.setItem("memracer:onboarding-org", JSON.stringify({ id: org.id, name: org.name })); setStep("project"); }, onError: (value) => setError(String(value)) });
  return <main className="onboarding-screen"><section className="onboarding-card"><span className="brand-mark">M</span><h1>Set up your factory</h1><p>{step === "org" ? "An Org holds your Projects and the people on them." : `Create your first Project in ${orgName}. A factory runs on two kinds of seat: a human seat is you — you describe the work you want; a coder seat is your coding agent — it writes the code and opens pull requests. You connect both right after this step.`}</p>
    <p className="scope-copy">New to memracer? <a href={HOW_THIS_WORKS_HREF}>{HOW_THIS_WORKS_LABEL}</a>.</p>
    {warning && <div role="status" className="create-warning">{warning}</div>}{error && <div role="alert" className="form-error">{error}</div>}
    {step === "org" ? <form onSubmit={(event) => { event.preventDefault(); setError(""); setWarning(""); if (orgName.trim()) createOrg.mutate(); }}><label>Org name<input ref={orgField} required value={orgName} onChange={(event) => { setOrgName(event.target.value); setWarning(""); }} /></label><button disabled={createOrg.isPending}>Create Org</button></form> : orgId ? <CreateProjectForm orgId={orgId} onCreated={finish} onError={setError} onWarning={(msg) => { setWarning(msg); if (!msg) setError(""); }} projectNameRef={projectField} usePlainButton submitLabel="Create Project" footer={<button className="link-button" type="button" onClick={() => { window.sessionStorage.removeItem("memracer:onboarding-org"); setStep("org"); setError(""); setWarning(""); }}>← Back to Org</button>} /> : null}
  </section></main>;
}

function knowledgeTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function decisionLabel(kind: string): string {
  return ({
    create: "Created",
    merge: "Consolidated",
    clarify: "Needs input",
    priority: "Reprioritized",
    approve: "Approved",
    revise: "Changes requested",
    answer: "Answered",
    escalate: "Escalated",
    close: "Closed",
    update: "Updated",
    hold: "Paused",
    reopen: "Reopened",
  } as Record<string, string>)[kind] ?? "Decision";
}

function TaskReference({ task, onTask }: { task: KnowledgeTaskRefDto; onTask: (id: number) => void }) {
  return <button className="knowledge-reference" type="button" onClick={() => onTask(task.id)}>Task · {task.title || "untitled"}</button>;
}

function ActiveKnowledge({ data, onConcept, onTask }: { data: KnowledgeActivityDto; onConcept: (path: string) => void; onTask: (id: number) => void }) {
  return <div className="knowledge-activity">
    <header><span>Project memory</span><h2>Knowledge activity</h2></header>
    <section className="knowledge-activity-section" aria-labelledby="knowledge-updates-title"><div className="knowledge-section-heading"><History size={14} /><h3 id="knowledge-updates-title">Recent updates</h3><span>{data.updates.length}</span></div>
      {data.updates.length === 0 ? <p className="empty-copy">No recorded updates yet.</p> : <div className="knowledge-activity-rows">{data.updates.map((update) => <article className="knowledge-activity-row" key={update.id}><BookOpen size={15} /><button className="knowledge-row-main" type="button" onClick={() => onConcept(update.path)}><b>{update.title || "untitled"}</b><span>{update.action === "wrote" ? "Written" : update.action === "updated" ? "Updated" : "Curated"} · {knowledgeTime(update.created_at)}</span></button><div className="knowledge-row-links">{update.task && <TaskReference task={update.task} onTask={onTask} />}{update.decision && <span>{decisionLabel(update.decision.kind)} · {update.decision.summary}</span>}</div></article>)}</div>}
    </section>
    <section className="knowledge-activity-section" aria-labelledby="knowledge-conventions-title"><div className="knowledge-section-heading"><ShieldCheck size={14} /><h3 id="knowledge-conventions-title">Conventions in force</h3><span>{data.conventions.length}</span></div>
      {data.conventions.length === 0 ? <p className="empty-copy">No active conventions recorded.</p> : <div className="knowledge-activity-rows">{data.conventions.map((item) => <article className="knowledge-activity-row" key={item.path}><ShieldCheck size={15} /><button className="knowledge-row-main" type="button" onClick={() => onConcept(item.path)}><b>{item.title || "untitled"}</b><span>{item.description}</span></button><div className="knowledge-row-links">{item.enforcement?.task ? <TaskReference task={item.enforcement.task} onTask={onTask} /> : <span>No related work recorded</span>}{item.enforcement && <span>{decisionLabel(item.enforcement.kind)} · {item.enforcement.summary}</span>}</div></article>)}</div>}
    </section>
    <section className="knowledge-activity-section" aria-labelledby="knowledge-decisions-title"><div className="knowledge-section-heading"><GitBranch size={14} /><h3 id="knowledge-decisions-title">Decisions</h3><span>{data.decisions.length}</span></div>
      {data.decisions.length === 0 ? <p className="empty-copy">No knowledge-linked decisions yet.</p> : <div className="knowledge-activity-rows">{data.decisions.map((decision) => {
        const primaryConcept = decision.concepts[0]?.path;
        return <article className="knowledge-activity-row" key={decision.id}><GitBranch size={15} /><button className="knowledge-row-main" type="button" disabled={!primaryConcept} onClick={() => { if (primaryConcept) onConcept(primaryConcept); }}><b>{decision.summary || "untitled"}</b><span>{decisionLabel(decision.kind)} · {knowledgeTime(decision.created_at)}</span></button><div className="knowledge-row-links">{decision.task && <TaskReference task={decision.task} onTask={onTask} />}{decision.concepts.map((linked) => <button className="knowledge-reference" type="button" key={linked.path} onClick={() => onConcept(linked.path)}>{linked.title || "untitled"}</button>)}</div></article>;
      })}</div>}
    </section>
  </div>;
}

export function KnowledgeView({ project, concept, onConcept, onTask }: { project: string; concept: string | null; onConcept: (path: string | null) => void; onTask: (id: number) => void }) {
  const activity = useQuery({ queryKey: queryKeys.knowledgeActivity(project), queryFn: () => dashboardApi.knowledgeActivity(project), retry: false });
  const list = useQuery({ queryKey: queryKeys.knowledge(project, ""), queryFn: () => dashboardApi.knowledge(project), retry: false });
  const doc = useQuery({ queryKey: queryKeys.knowledgeDoc(project, concept ?? ""), queryFn: () => dashboardApi.knowledgeDoc(project, concept!), enabled: Boolean(concept), retry: false });
  const root = useRef<HTMLElement>(null);
  const listView = resolveQueryView({ error: list.isError, pending: list.isPending, empty: (list.data?.concepts.length ?? 0) === 0 });
  const activityView = resolveQueryView({ error: activity.isError, pending: activity.isPending, empty: false });
  const docView = resolveQueryView({ error: doc.isError, pending: doc.isPending, empty: Boolean(concept) && !doc.data });
  const returnToExplorer = () => {
    const selectedPath = concept;
    onConcept(null);
    requestAnimationFrame(() => {
      const rows = root.current?.querySelectorAll<HTMLElement>("[data-knowledge-path]") ?? [];
      [...rows].find((row) => row.dataset.knowledgePath === selectedPath)?.focus();
    });
  };
  return <section ref={root} className={`knowledge-view ${concept ? "is-reading" : ""}`} aria-label="Project knowledge">
    <aside className="knowledge-list"><header><span><FolderTree size={15} /><h2>Explorer</h2></span><strong>{list.data?.concepts.length ?? 0} files</strong></header>
      {listView === "error" ? <ErrorState label="Knowledge explorer unavailable." retry={() => void list.refetch()} />
        : listView === "loading" ? <LoadingState label="Loading concepts…" />
          : listView === "empty" ? <EmptyState label="No project knowledge yet." />
            : <KnowledgeTree concepts={list.data?.concepts ?? []} project={project} selectedPath={concept} onConcept={onConcept} />}
    </aside>
    <article className="knowledge-reader">{concept && <button className="knowledge-back" type="button" onClick={returnToExplorer}><ArrowLeft size={13} /> Knowledge</button>}{!concept
      ? activityView === "error" ? <ErrorState label="Knowledge activity unavailable." retry={() => void activity.refetch()} />
        : activityView === "loading" ? <LoadingState label="Loading knowledge activity…" />
          : activity.data && <ActiveKnowledge data={activity.data} onConcept={onConcept} onTask={onTask} />
      : docView === "error" ? <ErrorState label="Concept unavailable." retry={() => void doc.refetch()} />
        : docView === "loading" ? <LoadingState label={`Loading ${concept}…`} />
          : docView === "empty" ? <EmptyState label="Concept not found." />
            : doc.data && <><header className="knowledge-document-header"><nav aria-label="Concept path">{doc.data.path.split("/").map((part, index, parts) => <React.Fragment key={`${part}:${index}`}><span aria-current={index === parts.length - 1 ? "page" : undefined}>{part}</span>{index < parts.length - 1 && <i aria-hidden="true">/</i>}</React.Fragment>)}</nav><div className="knowledge-document-title"><FileText size={18} /><div><span>{doc.data.type}</span><h2>{doc.data.title}</h2></div><time dateTime={new Date(doc.data.updated_at).toISOString()}>Updated {knowledgeTime(doc.data.updated_at)}</time></div><p>{doc.data.description}</p>{doc.data.tags.length > 0 && <div className="tag-row" aria-label="Concept tags">{doc.data.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}</header><KnowledgeBody body={doc.data.body} linkTargets={doc.data.linkTargets} onConcept={onConcept} />{doc.data.provenance.length > 0 && <section className="knowledge-provenance"><h2>Related work</h2>{doc.data.provenance.map((item) => <div key={item.id}><b>{item.summary}</b><span>{decisionLabel(item.kind)} · {knowledgeTime(item.created_at)}</span>{item.task && <TaskReference task={item.task} onTask={onTask} />}</div>)}</section>}{doc.data.links.length > 0 && <section><h2>Links to</h2>{doc.data.links.map((link) => <button key={link.path} onClick={() => onConcept(link.path)}>{link.title}</button>)}</section>}{doc.data.backlinks.length > 0 && <section><h2>Cited by</h2>{doc.data.backlinks.map((link) => <button key={link.path} onClick={() => onConcept(link.path)}>{link.title}</button>)}</section>}</>}
    </article>
  </section>;
}

function DeleteProject({ membership, onDeleted }: { membership: MembershipDto; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const mutation = useMutation({ mutationFn: () => dashboardApi.deleteProject(membership.projectId, name), onSuccess: () => { setOpen(false); setName(""); onDeleted(); } });
  return <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setName(""); }}><Dialog.Trigger asChild><Button variant="danger" type="button"><Trash2 size={12} />Delete Project</Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="task-sheet-overlay" /><Dialog.Content className="delete-dialog"><Dialog.Title>Archive {membership.projectName}</Dialog.Title><Dialog.Description>Archives this Project for 30 days (hidden from the fleet and queue). You can restore within that window; after 30 days it is permanently purged. Ops backups expire ~35 days after archive. Type the exact Project name to continue.</Dialog.Description><label>Project name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>{mutation.isError && <p role="alert">{String(mutation.error)}</p>}<footer><Dialog.Close asChild><Button>Cancel</Button></Dialog.Close><Button variant="danger" disabled={name !== membership.projectName || mutation.isPending} onClick={() => mutation.mutate()}>Archive Project</Button></footer><Dialog.Close className="task-sheet-close" aria-label="Close"><X size={16} /></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function peopleByUser<T extends { userId: string; role: "human" | "coder" | "admin" }>(members: T[]): T[] {
  const people = new Map<string, T>();
  for (const member of members) {
    if (member.role === "coder") continue;
    const current = people.get(member.userId);
    if (!current || member.role === "admin") people.set(member.userId, member);
  }
  return [...people.values()];
}

function keyDate(timestamp: number | null): string {
  return timestamp == null ? "Never" : new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
}

const ROLE_HELP = {
  human: "Human seats submit, discuss, and follow up on Project work.",
  coder: "Coder seats claim and complete Project work.",
  admin: "Admins manage Project access, seats, and destructive settings.",
} as const;

function RoleBadge({ role }: { role: "human" | "coder" | "admin" }) {
  const variant = role === "admin" ? "warning" : role === "coder" ? "live" : "neutral";
  return <Tooltip content={ROLE_HELP[role]}><Badge className="access-role" variant={variant} tabIndex={0}>{role[0].toUpperCase() + role.slice(1)}</Badge></Tooltip>;
}

function MemberAccessRow({ member }: { member: { userId: string | null; name: string; email: string | null; role: "human" | "coder" | "admin"; joinedAt: number | null } }) {
  const actorRole = member.role === "coder" ? "coder" : "human";
  return <div className="member-row" data-member-id={member.userId ?? member.name}>
    <Avatar name={member.name} role={actorRole} size={26} />
    <span className="member-identity"><b>{member.name}</b><span>{member.email ?? "No email recorded"}</span><time dateTime={member.joinedAt == null ? undefined : new Date(member.joinedAt).toISOString()}>Joined {member.joinedAt == null ? "date unavailable" : keyDate(member.joinedAt)}</time></span>
    <RoleBadge role={member.role} />
  </div>;
}

const CONTRIBUTION_TYPES: Array<{ key: keyof Omit<AnalyticsContributionCountsDto, "total">; label: string }> = [
  { key: "steer", label: "Steer" },
  { key: "create", label: "Create" },
  { key: "complete", label: "Complete" },
  { key: "answer", label: "Answer" },
];

function formatDelta(value: number | null, currency = false): string {
  if (value === null) return "No prior window";
  const amount = currency ? formatUsd(Math.abs(value)) : Math.abs(value).toLocaleString();
  return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${amount} vs prior`;
}

function MetricRail({ analytics }: { analytics: AnalyticsDto }) {
  const metrics = [
    ["Contributions", analytics.headline.contributions, analytics.headline.trends.contributions, false],
    ["Tasks shipped", analytics.headline.tasks_shipped, analytics.headline.trends.tasks_shipped, false],
    ["People · active", analytics.headline.active_members, analytics.headline.trends.active_members, false],
    ["Frigg jobs", analytics.headline.frigg_jobs, analytics.headline.trends.frigg_jobs, false],
    ["Frigg spend", analytics.headline.total_cost_usd, analytics.headline.trends.frigg_spend, true],
  ] as const;
  return <div className="analytics-metric-rail" aria-label="Team analytics headline metrics">{metrics.map(([label, value, delta, currency]) => <div className="analytics-metric" key={label}><strong>{currency ? formatUsd(value) : value.toLocaleString()}</strong><span>{label}</span><small className={delta !== null && delta < 0 ? "is-down" : ""}>{formatDelta(delta, currency)}</small></div>)}</div>;
}

function AnalyticsLegend({ className = "" }: { className?: string }) {
  return <div className={`analytics-series-legend ${className}`} aria-label="Contribution legend">{CONTRIBUTION_TYPES.map(({ key, label }) => <span key={key}><i className={`analytics-segment analytics-segment-${key}`} />{label}</span>)}</div>;
}

function StackedBar({ counts, scale, label, className = "" }: { counts: AnalyticsContributionCountsDto; scale: number; label: string; className?: string }) {
  const totalWidth = Math.min(100, scale <= 0 ? 0 : (counts.total / scale) * 100);
  return <div className={`analytics-stacked-bar ${className}`} role="img" aria-label={`${label}: ${CONTRIBUTION_TYPES.map(({ key, label: typeLabel }) => `${typeLabel} ${counts[key]}`).join(", ")}; total ${counts.total}`} style={{ width: `${totalWidth}%` }}><div className="analytics-stacked-bar-inner">{CONTRIBUTION_TYPES.map(({ key, label: typeLabel }) => counts[key] > 0 ? <i key={key} className={`analytics-segment analytics-segment-${key}`} style={{ width: `${(counts[key] / Math.max(counts.total, 1)) * 100}%` }} title={`${typeLabel}: ${counts[key]}`} /> : null)}</div></div>;
}

function ContributorLeaderboard({ analytics }: { analytics: AnalyticsDto }) {
  const scale = Math.max(...analytics.contributors.map((member) => member.contributions.total), 1);
  return <SidebarSection className="analytics-panel analytics-contributors"><header className="admin-section-heading"><div><h2>Contributor leaderboard</h2><p>One shared scale · expand a person for coder-seat detail.</p></div><Activity size={18} /></header><AnalyticsLegend /><div className="analytics-contributor-list" aria-label="Contributor leaderboard">{analytics.contributors.map((member, index) => <details key={member.id ?? member.name} className="analytics-contributor"><summary><span className="analytics-rank">{String(index + 1).padStart(2, "0")}</span><Avatar name={member.name} role={member.role === "coder" ? "coder" : "human"} size={28} /><span className="analytics-contributor-identity"><b>{member.name}</b><small><RoleBadge role={member.role} />{member.name_collision ? " · name collision" : ""}</small></span><StackedBar counts={member.contributions} scale={scale} label={`${member.name} contributions`} className="analytics-contributor-bar" /><strong className="analytics-contributor-total">{member.contributions.total}</strong></summary><div className="analytics-contributor-detail">{member.agent_contributions.length === 0 ? <span className="analytics-no-agent">No coder-seat contributions in this window.</span> : member.agent_contributions.map((agent) => <div className="analytics-agent-contribution" key={agent.id}><span>{agent.label}</span><StackedBar counts={agent.contributions} scale={scale} label={`${agent.label} contributions`} /><strong>{agent.contributions.total}</strong></div>)}</div></details>)}</div></SidebarSection>;
}


function SpendOverTimeChart({ analytics }: { analytics: AnalyticsDto }) {
  const series = analytics.spend_series ?? [];
  const maxTotal = Math.max(...series.map((bucket) => bucket.total_usd), 0);
  const models = [...new Set(series.flatMap((bucket) => bucket.segments.map((segment) => segment.model)))]
    .sort(compareScorecardModels);
  return <SidebarSection className="analytics-panel analytics-spend-chart" aria-label="Spend over time">
    <header className="admin-section-heading">
      <div><h2>Spend over time</h2><p>Stacked by model · {analytics.window.label} · {analytics.period === "24h" ? "hourly" : "daily"} buckets.</p></div>
      <BarChart3 size={18} />
    </header>
    {series.length === 0 ? <EmptyState label="No Frigg spend in this window." /> : <>
      <div className="analytics-spend-legend" aria-label="Spend model legend">
        {models.map((model) => (
          <span className="analytics-spend-legend-item" key={model}>
            <i className={`analytics-model-swatch analytics-model-${modelFamily(model)}`} aria-hidden="true" />
            <span>{model === "unknown" ? "unattributed" : model}</span>
          </span>
        ))}
      </div>
      <div className="analytics-spend-plot" role="img" aria-label="Stacked spend by model over time">
        {series.map((bucket) => (
          <div className="analytics-spend-column" key={bucket.bucket}>
            <div className="analytics-spend-stack" style={{ height: `${maxTotal > 0 ? Math.max((bucket.total_usd / maxTotal) * 100, 4) : 0}%` }}>
              {bucket.segments.map((segment) => (
                <i
                  key={segment.model}
                  className={`analytics-spend-segment analytics-model-${modelFamily(segment.model)}`}
                  style={{ flexGrow: segment.cost_usd, flexBasis: 0 }}
                  title={`${bucket.label} · ${segment.model === "unknown" ? "unattributed" : segment.model} · ${formatUsd(segment.cost_usd)}`}
                />
              ))}
            </div>
            <span className="analytics-spend-label">{bucket.label}</span>
            <code className="analytics-spend-total" title={formatUsd(bucket.total_usd)}>{formatUsd(bucket.total_usd)}</code>
          </div>
        ))}
      </div>
    </>}
  </SidebarSection>;
}

function FriggPanels({ analytics }: { analytics: AnalyticsDto }) {
  const routingTotal = Math.max(analytics.routing.reduce((sum, row) => sum + row.invocations, 0), 1);
  const scorecard = [...analytics.scorecard].sort((left, right) => right.completions - left.completions || left.kind.localeCompare(right.kind));
  const scorecardScale = Math.max(...scorecard.map((row) => row.completions), 1);
  return <div className="analytics-frigg-grid">
    <SidebarSection className="analytics-panel analytics-routing">
      <header className="admin-section-heading">
        <div><h2>Frigg model routing</h2><p>Share of provider calls · per-model spend.</p></div>
        <Gauge size={18} />
      </header>
      <div className="analytics-model-legend analytics-series-legend" aria-label="Model legend">
        <span><i className="analytics-model-dot analytics-model-gemini" />gemini</span>
        <span><i className="analytics-model-dot analytics-model-glm" />glm</span>
        <span><i className="analytics-model-dot analytics-model-other" />other</span>
        <span><i className="analytics-model-dot analytics-model-unknown" />unattributed</span>
      </div>
      {analytics.routing.length === 0 ? <EmptyState label="No routing calls in this window." /> : (
        <div className="analytics-routing-list">
          {analytics.routing.map((row) => (
            <div className="analytics-routing-row" key={`${row.model}:${row.rollout_arm}`}>
              <span className="analytics-routing-label"><b>{row.model}</b><small>{row.rollout_arm}</small></span>
              <span className="analytics-routing-track">
                <i className={`analytics-model-bar analytics-model-${modelFamily(row.model)}`} style={{ width: `${(row.invocations / routingTotal) * 100}%` }} />
              </span>
              <strong>{row.invocations}</strong>
              <code className="analytics-routing-spend" title={`Spend ${formatUsd(row.cost_usd)}`}>{formatUsd(row.cost_usd)}</code>
            </div>
          ))}
        </div>
      )}
    </SidebarSection>
    <SidebarSection className="analytics-panel analytics-scorecard">
      <header className="admin-section-heading">
        <div><h2>Frigg scorecard</h2><p>Completions stacked by model · failures marked red.</p></div>
        <BarChart3 size={18} />
      </header>
      {scorecard.length === 0 ? <EmptyState label="No scored jobs in this window." /> : (
        <div className="analytics-scorecard-list">
          {scorecard.map((row) => {
            const trackWidth = scorecardScale <= 0 ? 0 : (row.completions / scorecardScale) * 100;
            const segments = row.by_model?.length
              ? row.by_model
              : row.completions > 0
                ? [{ model: "unknown", completions: row.completions, cost_usd: row.cost_usd }]
                : [];
            const segmentTotal = Math.max(segments.reduce((sum, s) => sum + s.completions, 0), 1);
            return (
              <div className="analytics-scorecard-row" key={row.kind}>
                <span>
                  <b>{row.kind}</b>
                  <small>{row.jobs} jobs · {formatUsd(row.cost_usd)}</small>
                </span>
                <span
                  className="analytics-scorecard-track"
                  role="img"
                  aria-label={`${row.kind}: ${segments.map((s) => `${s.model} ${s.completions}`).join(", ")}${row.failed > 0 ? `; failed ${row.failed}` : ""}`}
                >
                  <span className="analytics-scorecard-stack" style={{ width: `${trackWidth}%` }}>
                    {segments.map((segment) => (
                      <i
                        key={segment.model}
                        className={`analytics-scorecard-segment analytics-model-${modelFamily(segment.model)}`}
                        style={{ width: `${(segment.completions / segmentTotal) * 100}%` }}
                        title={`${segment.model}: ${segment.completions} · ${formatUsd(segment.cost_usd)}`}
                      />
                    ))}
                  </span>
                  {row.failed > 0 && (
                    <i className="analytics-scorecard-failed" style={{ width: `${(row.failed / scorecardScale) * 100}%` }} />
                  )}
                </span>
                <strong>{row.completions}</strong>
              </div>
            );
          })}
        </div>
      )}
    </SidebarSection>
  </div>;
}

export function TeamView({ membership }: { membership: MembershipDto }) {
  const [period, setPeriod] = useState<AnalyticsPeriod>("7d");
  const analytics = useQuery({ queryKey: queryKeys.analytics(membership.projectId, period), queryFn: () => dashboardApi.analytics(membership.projectId, period), retry: false });
  const view = resolveQueryView({ error: analytics.isError && !analytics.data, pending: analytics.isPending && !analytics.data, empty: false });
  return <Card className="team-analytics-view" aria-label="Team analytics"><div className="analytics-view-toolbar"><p>Contribution and Frigg telemetry · {analytics.data?.window.label ?? "last 7 days"}</p><Select ariaLabel="Analytics time window" value={period} onValueChange={(value) => setPeriod(value as AnalyticsPeriod)} options={[{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "all", label: "All time" }]} /></div>{view === "error" ? <ErrorState label="Team analytics unavailable." retry={() => void analytics.refetch()} /> : view === "loading" ? <LoadingState label="Loading team analytics…" /> : analytics.data ? <><MetricRail analytics={analytics.data} /><div className="analytics-grid"><ContributorLeaderboard analytics={analytics.data} /></div><FriggPanels analytics={analytics.data} /><SpendOverTimeChart analytics={analytics.data} /></> : <EmptyState label="No team analytics yet." />}</Card>;
}

function ProjectInferencePanel({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const inference = useQuery({
    queryKey: queryKeys.projectInference(projectId),
    queryFn: () => dashboardApi.projectInference(projectId),
    retry: false,
  });
  const [mode, setMode] = useState<"inherit" | "org_key" | "project_secret">("inherit");
  const [orgKeyId, setOrgKeyId] = useState("");
  const [projectSecret, setProjectSecret] = useState("");
  const [liteMode, setLiteMode] = useState<"use_default" | "override">("use_default");
  const [liteModel, setLiteModel] = useState("");
  const [thinkingMode, setThinkingMode] = useState<"use_default" | "override">("use_default");
  const [thinkingModel, setThinkingModel] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!inference.data) return;
    setMode(inference.data.providerKeyMode);
    setOrgKeyId(inference.data.providerKeyId ?? "");
    setLiteMode((inference.data.liteModelMode as "use_default" | "override") || "use_default");
    setLiteModel(inference.data.liteModel ?? "");
    setThinkingMode((inference.data.thinkingModelMode as "use_default" | "override") || "use_default");
    setThinkingModel(inference.data.thinkingModel ?? "");
  }, [inference.data]);

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { providerKeyMode: mode };
      if (mode === "org_key") body.providerKeyId = orgKeyId || null;
      if (mode === "project_secret" && projectSecret.trim()) body.projectSecret = projectSecret.trim();
      if (mode === "inherit") body.clearProjectSecret = true;
      if (inference.data?.allowProjectModelOverride) {
        body.liteModelMode = liteMode;
        body.liteModel = liteMode === "override" ? liteModel.trim() : null;
        body.thinkingModelMode = thinkingMode;
        body.thinkingModel = thinkingMode === "override" ? thinkingModel.trim() : null;
      }
      return dashboardApi.updateProjectInference(projectId, body);
    },
    onSuccess: () => {
      setProjectSecret("");
      setError("");
      void client.invalidateQueries({ queryKey: queryKeys.projectInference(projectId) });
    },
    onError: (err) => setError(String(err)),
  });

  if (inference.isPending && !inference.data) return <LoadingState label="Loading inference settings…" />;
  if (inference.isError && !inference.data) {
    return <ErrorState label="Inference settings unavailable." retry={() => void inference.refetch()} />;
  }
  if (!inference.data) return null;

  return (
    <SidebarSection className="admin-panel" aria-label="Project inference">
      <header className="admin-section-heading">
        <div>
          <h2>Inference · BYOK</h2>
          <p className="scope-copy">
            Inherits the org provider and catalog models unless you override here (overrides only when the org allows them).
            Use for spend isolation with a different key.
            {inference.data.projectKeyLast4 ? ` Project secret ends …${inference.data.projectKeyLast4}.` : ""}
          </p>
        </div>
      </header>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Provider key
          <Select
            ariaLabel="Project provider key mode"
            value={mode}
            onValueChange={(value) => setMode(value as typeof mode)}
            options={[
              { value: "inherit", label: "Inherit org default key" },
              { value: "org_key", label: "Use a named org key" },
              { value: "project_secret", label: "Project-scoped secret" },
            ]}
          />
        </label>
        {mode === "org_key" && (
          <label>
            Org key
            <Select
              ariaLabel="Org provider key"
              value={orgKeyId}
              onValueChange={setOrgKeyId}
              options={inference.data.orgKeys.map((key) => ({
                value: key.id,
                label: `${key.label} …${key.last4}${key.isDefault ? " (default)" : ""}`,
              }))}
            />
          </label>
        )}
        {mode === "project_secret" && (
          <label>
            Project API key (write-only)
            <input
              type="password"
              autoComplete="off"
              placeholder={inference.data.projectKeyLast4 ? `replace …${inference.data.projectKeyLast4}` : "sk-…"}
              value={projectSecret}
              onChange={(event) => setProjectSecret(event.target.value)}
            />
          </label>
        )}
        {inference.data.allowProjectModelOverride && (
          <>
            <label>
              Lite model mode
              <Select
                ariaLabel="Project lite model mode"
                value={liteMode}
                onValueChange={(value) => setLiteMode(value as typeof liteMode)}
                options={[
                  { value: "use_default", label: "Catalog / org default" },
                  { value: "override", label: "Override model id" },
                ]}
              />
            </label>
            {liteMode === "override" && (
              <label>
                Lite model id
                <input value={liteModel} onChange={(event) => setLiteModel(event.target.value)} />
              </label>
            )}
            <label>
              Thinking model mode
              <Select
                ariaLabel="Project thinking model mode"
                value={thinkingMode}
                onValueChange={(value) => setThinkingMode(value as typeof thinkingMode)}
                options={[
                  { value: "use_default", label: "Catalog / org default" },
                  { value: "override", label: "Override model id" },
                ]}
              />
            </label>
            {thinkingMode === "override" && (
              <label>
                Thinking model id
                <input value={thinkingModel} onChange={(event) => setThinkingModel(event.target.value)} />
              </label>
            )}
          </>
        )}
        <Button type="submit" disabled={save.isPending}>Save inference</Button>
        {error && <p role="alert">{error}</p>}
      </form>
    </SidebarSection>
  );
}

export function SettingsView({ membership, onMembershipChange }: { membership: MembershipDto; onMembershipChange: (project?: string, warning?: string) => void }) {
  const project = membership.projectId;
  const client = useQueryClient();
  const session = useQuery({ queryKey: queryKeys.session, queryFn: dashboardApi.session, retry: false });
  const team = useQuery({ queryKey: queryKeys.team(project), queryFn: () => dashboardApi.team(project) });
  const roster = useQuery({ queryKey: queryKeys.orgRoster(membership.orgId ?? ""), queryFn: () => dashboardApi.orgRoster(membership.orgId!), enabled: Boolean(membership.orgId), retry: false });
  const invites = useQuery({ queryKey: queryKeys.invites(project), queryFn: () => dashboardApi.invites(project), enabled: membership.role === "admin", retry: false });
  const keys = useQuery({ queryKey: queryKeys.apiKeys(project), queryFn: () => dashboardApi.apiKeys(project) });
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"human" | "coder" | "admin">("human");
  const [inviteReveal, setInviteReveal] = useState<string | null>(null);
  const [enrollReveal, setEnrollReveal] = useState<{ role: string; prompt: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const revokeConfirm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (session.data?.name) setDisplayName(session.data.name);
  }, [session.data?.name]);
  const invite = useMutation({ mutationFn: ({ email, role }: { email: string; role: "human" | "coder" | "admin" }) => dashboardApi.createInvite(project, email, role), onSuccess: (value) => { setInviteReveal(value.inviteUrl); setEmail(""); void client.invalidateQueries({ queryKey: queryKeys.invites(project) }); } });
  const invalidateProjectSeats = () => {
    void client.invalidateQueries({ queryKey: queryKeys.apiKeys(project) });
    void client.invalidateQueries({ queryKey: queryKeys.seatReadiness(project) });
  };
  const mintEnrollment = useMutation({ mutationFn: (role: string) => dashboardApi.mintEnrollment(project, role), onSuccess: (value) => { setEnrollReveal({ role: value.role, prompt: value.prompt }); invalidateProjectSeats(); } });
  const revoke = useMutation({ mutationFn: (id: string) => dashboardApi.revokeApiKey(project, id), onSuccess: () => { setConfirmRevoke(null); invalidateProjectSeats(); } });
  const rename = useMutation({ mutationFn: (seat: { id: string; name: string }) => dashboardApi.updateApiKey(project, seat.id, { name: seat.name.trim() }), onSuccess: () => { setRenaming(null); void client.invalidateQueries({ queryKey: queryKeys.apiKeys(project) }); } });
  const saveDisplayName = useMutation({
    mutationFn: () => dashboardApi.updateDisplayName(displayName.trim()),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.session });
      void client.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
  const submitInvite = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (email.trim()) invite.mutate({ email: email.trim(), role: inviteRole }); };
  useEffect(() => { if (confirmRevoke) revokeConfirm.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [confirmRevoke]);
  const projectPeople = team.data?.members.filter((member) => member.role !== "coder") ?? [];
  const orgPeople = peopleByUser(roster.data?.members ?? []);
  const teamView = resolveQueryView({ error: team.isError && !team.data, pending: team.isPending && !team.data, empty: projectPeople.length === 0 });
  const rosterView = resolveQueryView({ error: roster.isError && !roster.data, pending: roster.isPending && !roster.data, empty: orgPeople.length === 0 });
  const invitesView = resolveQueryView({ error: invites.isError && !invites.data, pending: invites.isPending && !invites.data, empty: (invites.data?.invites.length ?? 0) === 0 });
  const keysView = resolveQueryView({ error: keys.isError && !keys.data, pending: keys.isPending && !keys.data, empty: (keys.data?.keys.length ?? 0) === 0 });
  return <Card className="settings-view" aria-label="Project settings"><header className="team-title"><div><span className="section-kicker">Project settings</span><h1>{membership.projectName}</h1><p>Access, GitHub, MCP seats, and destructive settings. Provider API keys and Frigg models live in Org settings (BYOK). <a href={HOW_THIS_WORKS_HREF}>{HOW_THIS_WORKS_LABEL}</a></p></div><div className="team-scope-summary" aria-label="Access summary"><span><b>{projectPeople.length}</b> people</span><span><b>{keys.data?.keys.length ?? 0}</b> seats</span></div></header>
    <div className="team-grid settings-section-stack">
      <div className="settings-band" data-settings-band="status">
        <p className="settings-band-label">Status</p>
      <SidebarSection className="admin-panel account-panel" aria-label="Account">
        <header className="admin-section-heading"><div><h2>Your account</h2><p className="scope-copy">Display name is set once at signup and edited here — not on every magic-link sign-in.</p></div></header>
        <form
          className="settings-form display-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (displayName.trim()) saveDisplayName.mutate();
          }}
        >
          <label>
            Display name
            <input
              required
              maxLength={80}
              aria-label="Display name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={session.data?.name || "Your name"}
            />
          </label>
          <p className="scope-copy">{session.data?.email ? `Signed in as ${session.data.email}` : "Signed in"}</p>
          <Button type="submit" disabled={saveDisplayName.isPending || !displayName.trim()}>Save name</Button>
          {saveDisplayName.isError && <p role="alert">{String(saveDisplayName.error)}</p>}
          {saveDisplayName.isSuccess && <p role="status">Display name saved.</p>}
        </form>
      </SidebarSection>
      </div>
      <div className="settings-band" data-settings-band="configure">
        <p className="settings-band-label">Configure</p>
      <section aria-labelledby="settings-integrations-heading" className="admin-panel"><h2 id="settings-integrations-heading" className="sr-only">Integrations</h2><GitHubConnectionPanel membership={membership} /></section><SidebarSection className="admin-panel people-panel" aria-label="Access"><header className="admin-section-heading"><div><h2>Access · {membership.projectName}</h2><p className="scope-copy">People with direct access to this Project.</p></div><UserPlus size={18} /></header>
        {team.isError && team.data && <ErrorState label="Project team could not refresh. Showing saved access." retry={() => void team.refetch()} />}
        {teamView === "error" ? <ErrorState label="Project team unavailable." retry={() => void team.refetch()} /> : teamView === "loading" ? <LoadingState label="Loading Project team…" /> : teamView === "empty" ? <EmptyState label="No people have Project access yet." /> : <div className="access-ledger" aria-label="Project access">{projectPeople.map((member, index) => <MemberAccessRow member={member} key={`${member.userId ?? member.name}:${index}`} />)}</div>}
        {membership.orgId && <details className="org-directory"><summary><span><Building2 size={14} />Organization directory · {membership.orgName ?? membership.orgId}</span><b>{roster.isPending && !roster.data ? "Loading" : `${orgPeople.length} people`}</b></summary><p>People across every Project in this organization.</p>{roster.isError && roster.data && <ErrorState label="Organization directory could not refresh. Showing saved access." retry={() => void roster.refetch()} />}{rosterView === "error" ? <ErrorState label="Organization directory unavailable." retry={() => void roster.refetch()} /> : rosterView === "loading" ? <LoadingState label="Loading organization directory…" /> : rosterView === "empty" ? <EmptyState label="No people belong to this organization yet." /> : <div className="access-ledger">{orgPeople.map((member) => <MemberAccessRow member={member} key={member.userId} />)}</div>}</details>}
        {membership.role === "admin" && <section className="invite-admin" aria-labelledby="invite-heading"><div className="admin-action-title"><div><h3 id="invite-heading">Invite access</h3><p>Create a role-specific join link for this Project. {INVITE_ROLE_HELP}</p></div></div><form className="invite-form" onSubmit={submitInvite}><label>Invite by email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Role<Select ariaLabel="Invite role" value={inviteRole} onValueChange={(value) => setInviteRole(value as typeof inviteRole)} options={[{ value: "human", label: "human" }, { value: "coder", label: "coder" }, { value: "admin", label: "admin" }]} /></label><Button disabled={invite.isPending}><UserPlus size={13} />Create invite</Button></form>{invite.isError && <p role="alert">{String(invite.error)}</p>}{inviteReveal && <div className="secret-reveal invite-reveal" role="status"><b>Join link</b><input aria-label="One-time invitation link" readOnly value={inviteReveal} onFocus={(event) => event.currentTarget.select()} /><CopyAction value={inviteReveal} label="Copy" /></div>}<div className="pending-invites"><h3>Pending invitations</h3>{invites.isError && invites.data && <ErrorState label="Pending invitations could not refresh. Showing saved invitations." retry={() => void invites.refetch()} />}{invitesView === "error" ? <ErrorState label="Pending invites unavailable." retry={() => void invites.refetch()} /> : invitesView === "loading" ? <LoadingState label="Loading pending invites…" /> : invitesView === "empty" ? <EmptyState label="No pending invitations." /> : invites.data?.invites.map((item) => <div className="invite-row" key={item.inviteUrl}><span><b>{item.email}</b><RoleBadge role={item.role} /></span><CopyAction value={item.inviteUrl} label="Copy link" /></div>)}</div></section>}
      </SidebarSection>
      {membership.role === "admin" && <ProjectInferencePanel projectId={project} />}
      <SidebarSection className="admin-panel token-panel" aria-label="Seats" data-testid="seats-panel">
        <header className="token-panel-heading"><div><h2>Seats</h2><p>Every seat is one connected human or coder, pinned to this Project and role. Add a seat by generating an onboarding prompt — the teammate or agent runs <code>memracer enroll</code> with the embedded token to connect. Provider inference keys live under Org settings.</p></div><span className="section-count"><b>{keys.data?.keys.length ?? 0}</b><KeyRound size={16} /></span></header>
        {membership.role === "admin" && <section className="seat-enroll" aria-labelledby="seat-enroll-heading" data-testid="roster-panel">
          <div className="admin-action-title"><div><h3 id="seat-enroll-heading">Add a seat</h3><p>Generate a one-paste onboarding prompt per role. The teammate installs the memracer CLI, then runs <code>memracer enroll</code> with the embedded token — the single way to connect a seat.</p></div></div>
          <div className="token-create">{ROSTER_ROLES.map((role) => <Button key={role} type="button" disabled={mintEnrollment.isPending} onClick={() => mintEnrollment.mutate(role)}><UserPlus size={13} />Generate {role} onboarding prompt</Button>)}</div>
          {mintEnrollment.isError && <p role="alert">{String(mintEnrollment.error)}</p>}
          {enrollReveal && <section className="secret-reveal setup-reveal" role="status" aria-label={`One-time onboarding prompt for ${enrollReveal.role}`}><header><div><b>{enrollReveal.role} onboarding prompt</b><p>Shown once. Copy it now — the embedded enrollment token expires in 15 minutes and can be redeemed only once.</p></div><Tooltip content="Close onboarding prompt"><Button variant="ghost" size="icon" type="button" onClick={() => setEnrollReveal(null)} aria-label="Close onboarding prompt"><X size={14} /></Button></Tooltip></header><pre className="setup-snippet" data-testid="roster-prompt">{enrollReveal.prompt}</pre><CopyAction value={enrollReveal.prompt} label="Copy prompt" /></section>}
        </section>}
        {(rename.isError || revoke.isError) && <p role="alert">{String(rename.error ?? revoke.error)}</p>}
        {keys.isError && keys.data && <ErrorState label="Seats could not refresh. Showing saved seats." retry={() => void keys.refetch()} />}
        {keysView === "error" ? <ErrorState label="Seats unavailable." retry={() => void keys.refetch()} /> : keysView === "loading" ? <LoadingState label="Loading seats…" /> : keysView === "empty" ? <EmptyState label={membership.role === "admin" ? "No seats connected yet. Generate an onboarding prompt above to add the first one." : "No seats connected yet. An admin generates onboarding prompts to add seats."} /> : <>
          <Table className="token-table" aria-label="Seats"><TableHeader><TableRow className="token-table-header"><TableHead>Seat</TableHead><TableHead>Role</TableHead><TableHead>Method</TableHead><TableHead>Created</TableHead><TableHead>Last used</TableHead><TableHead className="sr-only">Actions</TableHead></TableRow></TableHeader>
            <TableBody>{keys.data?.keys.map((key) => <TableRow className="token-row" key={key.id}><TableCell data-label="Seat"><b>{key.name}</b></TableCell><TableCell data-label="Role"><Badge className={`token-type token-type-${key.type}`}>{key.type === "coder" ? "Coder" : "Human"}</Badge></TableCell><TableCell data-label="Method"><code>{key.authMethod === "oauth" ? "OAuth" : key.prefix}</code></TableCell><TableCell data-label="Created">{keyDate(key.createdAt)}</TableCell><TableCell data-label="Last used">{keyDate(key.lastUsedAt)}</TableCell><TableCell className="token-actions"><Button variant="ghost" size="sm" type="button" onClick={() => setRenaming({ id: key.id, name: key.name })}>Rename</Button><Button variant="ghost" size="sm" type="button" onClick={() => setConfirmRevoke(key.id)}>Revoke</Button></TableCell></TableRow>)}</TableBody>
          </Table>
          {renaming && <form className="token-confirm" onSubmit={(event) => { event.preventDefault(); if (renaming.name.trim()) rename.mutate(renaming); }}><label>Seat name<input required maxLength={80} value={renaming.name} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} /></label><Button disabled={rename.isPending}>Save</Button><Button variant="ghost" type="button" onClick={() => setRenaming(null)}>Cancel</Button></form>}
          {keys.data?.keys.filter((key) => key.id === confirmRevoke).map((key) => <div ref={revokeConfirm} className="token-confirm" role="alertdialog" aria-label={`Confirm revoke ${key.name}`} key={key.id}><span>Revoke '{key.name}'? This disconnects its seat.</span><Button variant="danger" onClick={() => revoke.mutate(key.id)} disabled={revoke.isPending}>Confirm revoke</Button><Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Cancel</Button></div>)}
        </>}
      </SidebarSection>
      </div>
      {membership.role === "admin" && (
        <div className="settings-band" data-settings-band="danger">
          <p className="settings-band-label">Danger</p>
          <section className="admin-panel danger-zone"><div><h2>Danger zone</h2><p>Archive for 30 days, then permanent purge. Exact Project name required; you recover to another membership if any remain.</p></div><DeleteProject membership={membership} onDeleted={onMembershipChange} /></section>
        </div>
      )}
    </div>
  </Card>;
}
