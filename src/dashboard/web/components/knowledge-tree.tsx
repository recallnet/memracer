import {
  hotkeysCoreFeature,
  searchFeature,
  selectionFeature,
  syncDataLoaderFeature,
  type Updater,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KnowledgeConceptDto } from "../data/dto.js";

export interface KnowledgeTreeNode {
  id: string;
  name: string;
  path: string | null;
  type: string | null;
  folder: boolean;
  children: string[];
  searchText: string;
}

export interface KnowledgeTreeModel {
  nodes: Map<string, KnowledgeTreeNode>;
  folderIds: string[];
  defaultExpanded: string[];
}

const ROOT_ID = "knowledge:root";
const folderId = (path: string) => `folder:${path}`;
const conceptId = (path: string) => `concept:${path}`;

export function knowledgeTreeAncestorIds(path: string | null): string[] {
  if (!path) return [ROOT_ID];
  const segments = path.split("/").filter(Boolean).slice(0, -1);
  return [ROOT_ID, ...segments.map((_, index) => folderId(segments.slice(0, index + 1).join("/")))];
}

export function reconcileKnowledgeTreeExpansion(
  model: KnowledgeTreeModel,
  expandedItems: string[],
  selectedPath: string | null,
): string[] {
  const valid = expandedItems.filter((id) => id === ROOT_ID || model.nodes.get(id)?.folder);
  const selectedAncestors = knowledgeTreeAncestorIds(selectedPath)
    .filter((id) => id === ROOT_ID || model.nodes.get(id)?.folder);
  return [...new Set([...valid, ...selectedAncestors])];
}

export function buildKnowledgeTree(concepts: KnowledgeConceptDto[]): KnowledgeTreeModel {
  const nodes = new Map<string, KnowledgeTreeNode>();
  nodes.set(ROOT_ID, { id: ROOT_ID, name: "Knowledge", path: null, type: null, folder: true, children: [], searchText: "knowledge" });

  for (const concept of concepts) {
    const segments = concept.path.split("/").filter(Boolean);
    let parentId = ROOT_ID;
    let folderPath = "";
    for (const segment of segments.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${segment}` : segment;
      const id = folderId(folderPath);
      if (!nodes.has(id)) {
        nodes.set(id, { id, name: segment, path: folderPath, type: null, folder: true, children: [], searchText: folderPath.toLowerCase() });
        nodes.get(parentId)!.children.push(id);
      }
      parentId = id;
    }
    const id = conceptId(concept.path);
    nodes.set(id, {
      id,
      name: concept.title,
      path: concept.path,
      type: concept.type,
      folder: false,
      children: [],
      searchText: `${concept.title} ${concept.path} ${concept.type} ${concept.description}`.toLowerCase(),
    });
    nodes.get(parentId)!.children.push(id);
  }

  for (const node of nodes.values()) {
    node.children.sort((leftId, rightId) => {
      const left = nodes.get(leftId)!;
      const right = nodes.get(rightId)!;
      return Number(right.folder) - Number(left.folder) || left.name.localeCompare(right.name);
    });
  }
  const folderIds = [...nodes.values()].filter((node) => node.folder && node.id !== ROOT_ID).map((node) => node.id);
  return { nodes, folderIds, defaultExpanded: [ROOT_ID, ...nodes.get(ROOT_ID)!.children.filter((id) => nodes.get(id)?.folder)] };
}

export function knowledgeTreeVisibleIds(model: KnowledgeTreeModel, query: string): Set<string> | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const visible = new Set<string>();
  for (const node of model.nodes.values()) {
    if (node.folder || !node.searchText.includes(normalized)) continue;
    visible.add(node.id);
    const segments = node.path!.split("/").slice(0, -1);
    for (let index = 1; index <= segments.length; index += 1) visible.add(folderId(segments.slice(0, index).join("/")));
  }
  return visible;
}

function applyUpdater<T>(current: T, updater: Updater<T>): T {
  return typeof updater === "function" ? (updater as (value: T) => T)(current) : updater;
}

export function KnowledgeTree({ concepts, project, selectedPath, onConcept }: {
  concepts: KnowledgeConceptDto[];
  project: string;
  selectedPath: string | null;
  onConcept: (path: string) => void;
}) {
  const model = useMemo(() => buildKnowledgeTree(concepts), [concepts]);
  const [expandedItems, setExpandedItems] = useState(() => reconcileKnowledgeTreeExpansion(model, model.defaultExpanded, selectedPath));
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const selectedItems = selectedPath ? [conceptId(selectedPath)] : [];
  const tree = useTree<KnowledgeTreeNode>({
    rootItemId: ROOT_ID,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().folder,
    dataLoader: {
      getItem: (id) => model.nodes.get(id)!,
      getChildren: (id) => model.nodes.get(id)?.children ?? [],
    },
    state: { expandedItems, focusedItem, selectedItems, search },
    setExpandedItems: (updater) => setExpandedItems((current) => applyUpdater(current, updater)),
    setFocusedItem: (updater) => setFocusedItem((current) => applyUpdater(current, updater)),
    setSelectedItems: () => undefined,
    setSearch: (updater) => setSearch((current) => applyUpdater(current, updater)),
    onPrimaryAction: (item) => {
      const node = item.getItemData();
      if (node.folder) {
        if (item.isExpanded()) item.collapse(); else item.expand();
      } else if (node.path) onConcept(node.path);
    },
    isSearchMatchingItem: (value, item) => item.getItemData().searchText.includes(value.trim().toLowerCase()),
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, searchFeature],
  });
  const query = search ?? "";
  const visibleIds = useMemo(() => knowledgeTreeVisibleIds(model, query), [model, query]);
  const visibleLeaves = visibleIds ? [...visibleIds].filter((id) => !model.nodes.get(id)?.folder).length : concepts.length;

  useEffect(() => {
    setExpandedItems(reconcileKnowledgeTreeExpansion(model, model.defaultExpanded, selectedPath));
    setFocusedItem(null);
    setSearch(null);
  }, [project]);
  useEffect(() => {
    setExpandedItems((current) => reconcileKnowledgeTreeExpansion(model, current, selectedPath));
  }, [model, selectedPath]);
  useEffect(() => {
    tree.rebuildTree();
  }, [model]);
  useEffect(() => {
    if (!query) return;
    setExpandedItems((current) => current.length === model.folderIds.length + 1 ? current : [ROOT_ID, ...model.folderIds]);
  }, [model, query]);
  useEffect(() => {
    if (!query || !selectedPath || visibleIds?.has(conceptId(selectedPath))) return;
    setSearch(null);
  }, [query, selectedPath, visibleIds]);

  const searchProps = tree.getSearchInputElementProps();
  return <>
    <label className="knowledge-search"><Search size={13} /><span className="sr-only">Search concepts</span><input {...searchProps} value={query} placeholder="Search knowledge" onBlur={() => undefined} onFocus={() => { if (search === null) tree.openSearch(""); }} /><span>{visibleLeaves}</span>{query && <button type="button" aria-label="Clear knowledge search" onClick={() => tree.closeSearch()}><X size={12} /></button>}</label>
    {visibleLeaves === 0 ? <p className="empty-copy">No concepts match this search.</p> : <div className="knowledge-tree" {...tree.getContainerProps("Knowledge concepts")}>
      {tree.getItems().filter((item) => !visibleIds || visibleIds.has(item.getId())).map((item) => {
        const node = item.getItemData();
        const level = item.getItemMeta().level;
        const itemProps = item.getProps();
        return <button {...itemProps} data-knowledge-path={node.folder ? undefined : node.path ?? undefined} onClick={(event) => { itemProps.onClick?.(event); if (node.folder) { if (item.isExpanded()) item.collapse(); else item.expand(); } else if (node.path) onConcept(node.path); }} aria-current={node.path === selectedPath ? "page" : undefined} className={`knowledge-tree-row ${node.folder ? "is-folder" : "is-concept"} ${item.isFocused() ? "is-focused" : ""} ${node.path === selectedPath ? "is-selected" : ""}`} key={item.getKey()} style={{ paddingLeft: `${12 + level * 16}px` }} type="button">
          <span className="knowledge-tree-caret">{node.folder ? item.isExpanded() ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
          {node.folder ? item.isExpanded() ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileText size={13} />}
          <span className="knowledge-tree-name">{node.name}</span>
        </button>;
      })}
    </div>}
  </>;
}
