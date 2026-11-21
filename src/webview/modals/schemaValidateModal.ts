// Modular JSON Schema Validation modal (load .schema.json or paste inline schema, non-blocking sliced validation, filter violations).
import { t } from '../../shared/i18n';
import { runSliced } from '../compute';
import { icon } from '../icons';
import { esc, type JVal } from '../json';
import { validateSingleRecord, type SchemaValidationReport, type SchemaViolation } from '../schemaValidate';
import { trapModalTabKey } from '../stateMachines';

export interface SchemaValidateHost {
  records(): Iterable<{ line: number; value: JVal }>;
  pickSchemaFile(): void;
  filterLines(label: string, lines: number[]): void;
  jumpToLine(line: number): void;
  onClose(): void;
}

export class SchemaValidateModal {
  readonly el: HTMLElement;
  private schemaText = '{\n  "type": "object",\n  "required": []\n}';
  private schemaName = '';
  private lastReport: SchemaValidationReport | null = null;
  private runAbort: AbortController | null = null;

  constructor(private readonly host: SchemaValidateHost) {
    this.el = document.createElement('div');
    this.el.className = 'modal-panel validate-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', t('Validate JSON Schema'));
    this.el.hidden = true;
    this.el.addEventListener('keydown', (e) => {
      trapModalTabKey(this.el, e);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.host.onClose();
      }
    });
  }

  open(): void {
    this.el.innerHTML = `
      <div class="ep-head">
        <span class="ep-title">${icon('check-doc', 14)} ${esc(t('Validate JSON Schema'))}</span>
        <span class="dim val-meta">${esc(this.schemaName)}</span>
      </div>
      <div class="val-split">
        <textarea class="val-input mono" spellcheck="false" aria-label="${esc(t('JSON Schema'))}">${esc(this.schemaText)}</textarea>
        <div class="val-results"></div>
      </div>
      <div class="ep-actions">
        <button class="btn primary" data-val-run>${esc(t('Validate'))}</button>
        <button class="btn" data-val-pick>${esc(t('Load .schema.json…'))}</button>
        <span class="spring"></span>
        <button class="btn" data-val-close>${esc(t('Close'))} <kbd>Esc</kbd></button>
      </div>`;

    const ta = this.el.querySelector('.val-input') as HTMLTextAreaElement;
    this.el.querySelector('[data-val-pick]')?.addEventListener('click', () => this.host.pickSchemaFile());
    this.el.querySelector('[data-val-run]')?.addEventListener('click', () => {
      this.schemaText = ta.value;
      void this.runValidation();
    });
    this.el.querySelector('[data-val-close]')?.addEventListener('click', () => this.host.onClose());
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        this.schemaText = ta.value;
        void this.runValidation();
      }
    });

    this.el.hidden = false;
    ta.focus();
  }

  setSchemaFromHost(name: string, text: string): void {
    this.schemaName = name;
    this.schemaText = text;
    if (!this.el.hidden) {
      const ta = this.el.querySelector('.val-input') as HTMLTextAreaElement | null;
      const meta = this.el.querySelector('.val-meta') as HTMLElement | null;
      if (ta) ta.value = text;
      if (meta) meta.textContent = name;
      void this.runValidation();
    }
  }

  private async runValidation(): Promise<void> {
    this.runAbort?.abort();
    const abort = new AbortController();
    this.runAbort = abort;

    const out = this.el.querySelector('.val-results') as HTMLElement | null;
    if (!out) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.schemaText);
    } catch (e) {
      out.innerHTML = `<div class="val-err">${esc(t('Invalid JSON Schema: {0}', e instanceof Error ? e.message : String(e)))}</div>`;
      return;
    }

    const items: { line: number; value: JVal }[] = [];
    for (const r of this.host.records()) items.push(r);

    let validLines = 0;
    const invalidLines: number[] = [];
    const violations: SchemaViolation[] = [];
    const ruleMap = new Map<string, number>();

    const completed = await runSliced(
      items.length,
      (i) => {
        const { line, value } = items[i];
        const lv = validateSingleRecord(line, value, parsed);
        if (lv.length === 0) {
          validLines++;
        } else {
          invalidLines.push(line);
          for (const v of lv) {
            ruleMap.set(v.rule, (ruleMap.get(v.rule) ?? 0) + 1);
            if (violations.length < 500) violations.push(v);
          }
        }
      },
      {
        signal: abort.signal,
        onProgress: (done, total) => {
          if (done < total && out.isConnected) {
            out.innerHTML = `<div class="dim">${esc(`${Math.round((done / Math.max(1, total)) * 100)}% (${done.toLocaleString()} / ${total.toLocaleString()})`)}</div>`;
          }
        },
      },
    );
    if (!completed || abort.signal.aborted || this.el.hidden) return;

    const rep: SchemaValidationReport = {
      checked: items.length,
      validLines,
      invalidLines,
      violations,
      ruleCounts: [...ruleMap.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
    };
    this.lastReport = rep;
    const summary =
      rep.invalidLines.length === 0
        ? `<div class="val-ok">${esc(t('All {0} records match the schema.', rep.checked.toLocaleString()))}</div>`
        : `<div class="val-summary">
            <span class="badge bad">${esc(t('{0} invalid', rep.invalidLines.length.toLocaleString()))}</span>
            <span class="dim">${esc(t('{0} valid of {1}', rep.validLines.toLocaleString(), rep.checked.toLocaleString()))}</span>
            <button class="btn" data-val-filter>${esc(t('Filter {0} invalid lines', rep.invalidLines.length.toLocaleString()))}</button>
          </div>`;
    const rows = rep.violations
      .slice(0, 200)
      .map(
        (v) =>
          `<tr class="val-row" data-vline="${v.line}"><td class="num mono">${v.line + 1}</td><td class="mono">${esc(v.path)}</td><td><span class="badge">${esc(v.rule)}</span></td><td>${esc(v.message)}</td></tr>`,
      )
      .join('');
    out.innerHTML =
      summary +
      (rows
        ? `<table class="cmp val-tbl"><thead><tr><th>#</th><th>${esc(t('Path'))}</th><th>${esc(t('Rule'))}</th><th>${esc(t('Detail'))}</th></tr></thead><tbody>${rows}</tbody></table>`
        : '');

    out.querySelector('[data-val-filter]')?.addEventListener('click', () => {
      if (this.lastReport?.invalidLines.length) {
        this.host.filterLines(t('Schema violations'), this.lastReport.invalidLines);
        this.host.onClose();
      }
    });
    out.querySelectorAll<HTMLElement>('[data-vline]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const line = Number(tr.dataset.vline);
        this.host.onClose();
        this.host.jumpToLine(line);
      });
    });
  }

  close(): void {
    this.runAbort?.abort();
    this.runAbort = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
