// Explicit, zero-dependency state machines for Better JSONL UI, query, lifecycle, mutation & I/O flows.
// Elevates UX (no stacked modals, focus return, no stuck drags), DX (typed transitions, no boolean soup),
// and AX (deterministic DOM data-* attributes & RenderReport.machines snapshot).

import type { WebviewMachineSnapshot } from '../shared/protocol';

// ---------- SM-1: Overlay (Modal & Popover) Exclusivity + Focus Return ----------

export type ModalId =
  | 'edit'
  | 'compare'
  | 'inspector'
  | 'schema'
  | 'batch'
  | 'pivot'
  | 'quality'
  | 'filediff'
  | 'trace'
  | 'settings';

export type PopoverId =
  | 'ctx-menu'
  | 'export-menu'
  | 'hist-menu'
  | 'ac-menu'
  | 'goto-box'
  | 'grid-filter'
  | 'col-picker';

export interface OverlayTransition {
  closeModal?: ModalId;
  closePopover?: PopoverId;
  restoreFocus?: HTMLElement | null;
}

export class OverlayController {
  private activeModal: ModalId | null = null;
  private activePopover: PopoverId | null = null;
  private modalOpener: HTMLElement | null = null;

  get modal(): ModalId | null {
    return this.activeModal;
  }

  get popover(): PopoverId | null {
    return this.activePopover;
  }

  get hasModal(): boolean {
    return this.activeModal !== null;
  }

  /** Opens `id`, closing any conflicting modal or transient popover and recording focus to restore. */
  openModal(id: ModalId, activeEl: Element | null): OverlayTransition {
    const closePopover = this.activePopover ?? undefined;
    this.activePopover = null;
    const closeModal = this.activeModal !== null && this.activeModal !== id ? this.activeModal : undefined;
    if (this.activeModal === null) {
      this.modalOpener =
        typeof HTMLElement !== 'undefined' &&
        activeEl instanceof HTMLElement &&
        !activeEl.closest('.menu, .modal-panel, .editpanel, .comparepanel, .settings')
          ? activeEl
          : null;
    }
    this.activeModal = id;
    return { closeModal, closePopover };
  }

  /** Marks `id` (or the current modal) closed and returns the element that should regain focus. */
  closeModal(id?: ModalId): OverlayTransition {
    if (this.activeModal === null) return {};
    if (id !== undefined && this.activeModal !== id) return {};
    const closed = this.activeModal;
    const restoreFocus = this.modalOpener;
    this.activeModal = null;
    this.modalOpener = null;
    return { closeModal: closed, restoreFocus };
  }

  /** Opens a transient menu/popover, closing any other open popover first. */
  openPopover(id: PopoverId): OverlayTransition {
    const closePopover = this.activePopover !== null && this.activePopover !== id ? this.activePopover : undefined;
    this.activePopover = id;
    return { closePopover };
  }

  closePopover(id?: PopoverId): OverlayTransition {
    if (this.activePopover === null) return {};
    if (id !== undefined && this.activePopover !== id) return {};
    const closed = this.activePopover;
    this.activePopover = null;
    return { closePopover: closed };
  }

  reset(): void {
    this.activeModal = null;
    this.activePopover = null;
    this.modalOpener = null;
  }
}

/** WCAG focus-ring trap for modal dialogs (`Tab` / `Shift+Tab`). */
export function trapModalTabKey(container: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), a[href], [tabindex="0"]',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// ---------- SM-2: Query Syntax & Virtual Projection Machine ----------

export type QuerySyntaxMode = 'auto' | 'regex' | 'literal';

export function normalizeQuerySyntax(regex?: boolean, literal?: boolean): QuerySyntaxMode {
  if (regex) return 'regex';
  if (literal) return 'literal';
  return 'auto';
}

export function toggleQuerySyntax(current: QuerySyntaxMode, toggle: 'regex' | 'literal'): QuerySyntaxMode {
  return current === toggle ? 'auto' : toggle;
}

export function syntaxToFlags(mode: QuerySyntaxMode): { regex: boolean; literal: boolean } {
  return { regex: mode === 'regex', literal: mode === 'literal' };
}

export type ProjectionState<M> =
  | { readonly kind: 'off' }
  | { readonly kind: 'active'; readonly phase: 'projecting' | 'projected'; readonly baseModel: M };

// ---------- SM-3: Document Ingestion & Scan Lifecycle ----------

export type DocLifecyclePhase = 'booting' | 'streaming' | 'parsing-json' | 'scanning' | 'ready' | 'error';

export function deriveDocLifecycle(opts: {
  hasViews: boolean;
  hasLoadStore: boolean;
  parsingJson: boolean;
  bootError: boolean;
  modelLoading: boolean;
  modelComplete: boolean;
}): DocLifecyclePhase {
  if (opts.bootError) return 'error';
  if (opts.parsingJson) return 'parsing-json';
  if (!opts.hasViews) return opts.hasLoadStore ? 'streaming' : 'booting';
  if (opts.modelLoading) return 'streaming';
  if (!opts.modelComplete) return 'scanning';
  return 'ready';
}

// ---------- SM-4: Record & Cell Mutation Transaction Machine ----------

export type MutationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'cell'; readonly record: number }
  | { readonly kind: 'record'; readonly record: number; readonly original: string }
  | { readonly kind: 'insert-open'; readonly openRecord: number }
  | { readonly kind: 'batch' };

// ---------- SM-5: Streaming Export Handshake Machine ----------

export type ExportStreamState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'streaming'; readonly id: number; readonly format: string; readonly next: () => string | null };

export function startExportStream(
  current: ExportStreamState,
  id: number,
  format: string,
  next: () => string | null,
): { nextState: ExportStreamState; cancelPreviousId?: number } {
  const cancelPreviousId = current.kind === 'streaming' ? current.id : undefined;
  return {
    nextState: { kind: 'streaming', id, format, next },
    cancelPreviousId,
  };
}

// ---------- SM-6: Search Input Multiplexer (Typing vs Autocomplete vs History) ----------

export type SearchInputState =
  | { readonly kind: 'typing' }
  | { readonly kind: 'autocomplete'; readonly index: number }
  | { readonly kind: 'history'; readonly cursor: number };

// ---------- AX Snapshot Builder ----------

export function buildMachineSnapshot(params: {
  lifecycle: DocLifecyclePhase;
  querySyntax: QuerySyntaxMode;
  projection: 'off' | 'projecting' | 'projected';
  searching: boolean;
  awaitingModules: boolean;
  modal: ModalId | null;
  popover: PopoverId | null;
  mutation: MutationState['kind'];
  exporting: boolean;
}): WebviewMachineSnapshot {
  return {
    lifecycle: params.lifecycle,
    querySyntax: params.querySyntax,
    projection: params.projection,
    search: params.awaitingModules ? 'awaiting-modules' : params.searching ? 'running' : 'idle',
    modal: params.modal,
    popover: params.popover,
    mutation: params.mutation,
    export: params.exporting ? 'streaming' : 'idle',
  };
}
