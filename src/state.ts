/**
 * Shared sitting state for the VS Code viewport.
 * Desk remains in core; this is ephemeral UI selection only.
 */
import type { Project, QueueEntry } from "./api";

/** Founding phase for the plugin desk panel. */
export type FoundingPhase = "none" | "interviewing" | "proposing" | "founded";

export type SittingState = {
  projectId: string | undefined;
  projectRoot: string | undefined;
  lastEntry: QueueEntry | undefined;
  entries: QueueEntry[];
  connected: boolean;
  statusText: string;
  foundingPhase: FoundingPhase;
};

type Listener = () => void;

const state: SittingState = {
  projectId: undefined,
  projectRoot: undefined,
  lastEntry: undefined,
  entries: [],
  connected: false,
  statusText: "Kettle",
  foundingPhase: "none",
};

const listeners = new Set<Listener>();

export function getState(): Readonly<SittingState> {
  return state;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener errors must not break the sitting */
    }
  }
}

export function setConnected(connected: boolean, statusText?: string): void {
  state.connected = connected;
  if (statusText != null) state.statusText = statusText;
  emit();
}

export function setProject(project: Project | undefined): void {
  state.projectId = project?.id;
  state.projectRoot = project?.root;
  emit();
}

export function setProjectId(id: string | undefined, root?: string): void {
  state.projectId = id;
  if (root !== undefined) state.projectRoot = root;
  emit();
}

export function setEntries(entries: QueueEntry[]): void {
  state.entries = entries;
  // Refresh lastEntry from fresh queue data when possible
  if (state.lastEntry) {
    const fresh = entries.find((e) => String(e.id) === String(state.lastEntry!.id));
    if (fresh) state.lastEntry = fresh;
  }
  emit();
}

export function setLastEntry(entry: QueueEntry | undefined): void {
  state.lastEntry = entry;
  emit();
}

export function getLastEntry(): QueueEntry | undefined {
  return state.lastEntry;
}

export function getProjectId(): string | undefined {
  return state.projectId;
}

export function getProjectRoot(): string | undefined {
  return state.projectRoot;
}

export function getEntries(): QueueEntry[] {
  return state.entries;
}

export function setFoundingPhase(phase: FoundingPhase): void {
  state.foundingPhase = phase;
  emit();
}

export function getFoundingPhase(): FoundingPhase {
  return state.foundingPhase;
}

/** Interview phase only (no desk proposal yet). */
export function isInterviewing(): boolean {
  return state.foundingPhase === "interviewing";
}

/** Charter proposal ready to edit + approve → found. */
export function isProposing(): boolean {
  return state.foundingPhase === "proposing";
}

/**
 * What the desk is doing beyond its founding phase: a finish or setup stream
 * running, or a desk core could not read. Drives the catalog state shown in the
 * status bar (ritualParity.deskStateName).
 */
export type DeskActivity = "idle" | "founding" | "sweeping" | "broken";

let activity: DeskActivity = "idle";

export function setDeskActivity(next: DeskActivity): void {
  if (activity === next) return;
  activity = next;
  emit();
}

export function getDeskActivity(): DeskActivity {
  return activity;
}
