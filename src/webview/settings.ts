import { languageName, t } from '../shared/i18n';
import type { SettingKey } from '../shared/protocol';
import type { App } from './app';
import { esc } from './json';
import { icon } from './icons';

type Option = [value: string, label: string];

/**
 * Settings drawer (like Git Map's). Every change is written to the VS Code settings by the
 * extension host (to the workspace when the workspace sets that value, to the user settings
 * otherwise), so the panel always shows the value in use.
 */
export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly content: HTMLElement;
  private opener: HTMLElement | null = null;
  open = false;

  constructor(private readonly app: App) {
    this.el = document.createElement('div');
    this.el.className = 'settings';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', t('Better JSONL settings'));
    this.el.innerHTML = `
      <div class="settings-head"><h2>${t('Settings')}</h2><span class="dim">Better JSONL</span><button class="icon-btn settings-close" aria-label="${t('Close settings')}">${icon('close', 16)}</button></div>
      <div class="settings-content" tabindex="0"></div>
      <div class="settings-foot"><span class="dim">${t('Saved to your VS Code settings.')}</span><a href="#" class="settings-link">${t('Open in VS Code Settings')}</a></div>`;
    this.content = this.el.querySelector('.settings-content') as HTMLElement;
    this.el.querySelector('.settings-close')!.addEventListener('click', () => this.close());
    this.el.querySelector('.settings-link')!.addEventListener('click', (e) => {
      e.preventDefault();
      this.app.post({ type: 'openSettings' });
    });
    this.content.addEventListener('click', (e) => this.onClick(e));
    this.content.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.open) return;
        const target = e.target as HTMLElement;
        if (!this.el.contains(target) && !target.closest('.gear-btn')) this.close();
      },
      { signal: this.app.shellSignal },
    );
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (!this.open && document.activeElement instanceof HTMLElement) this.opener = document.activeElement;
    this.open = true;
    this.refresh();
    this.el.classList.add('active');
    (this.el.querySelector('.settings-close') as HTMLElement).focus();
    this.app.stateChanged();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('active');
    const back = this.opener;
    this.opener = null;
    if (back && document.contains(back)) back.focus({ preventScroll: true });
    this.app.stateChanged();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Tab') {
      const focusable = Array.from(this.el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && (e.target as HTMLElement).closest('.settings-seg')) {
      const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLElement | null;
      const grp = btn?.closest('.settings-seg');
      if (!btn || !grp) return;
      e.preventDefault();
      const btns = Array.from(grp.querySelectorAll<HTMLElement>('.seg-btn'));
      const idx = btns.indexOf(btn);
      const next = btns[(idx + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
      next.focus();
      next.click();
    }
  }

  /** Re-renders from the current config (after a change from here or from settings.json). */
  refresh(): void {
    if (!this.open) return;
    const c = this.app.config;
    const seg = (key: SettingKey, groupLabel: string, options: Option[], selected: string) =>
      `<div class="seg settings-seg" role="radiogroup" aria-label="${esc(groupLabel)}" data-key="${key}">${options
        .map(([v, label]) => `<button role="radio" class="seg-btn sub${v === selected ? ' on' : ''}" aria-checked="${v === selected}" data-value="${esc(v)}">${esc(label)}</button>`)
        .join('')}</div>`;
    const row = (label: string, control: string, hint = '') =>
      `<div class="settings-row"><span class="settings-label">${esc(label)}</span><div class="settings-control">${control}${hint ? `<span class="settings-hint">${esc(hint)}</span>` : ''}</div></div>`;
    const check = (key: SettingKey, label: string, value: boolean, hint: string) =>
      `<label class="settings-check"><input type="checkbox" data-key="${key}"${value ? ' checked' : ''}><span><span class="settings-check-label">${esc(label)}</span><span class="settings-hint">${esc(hint)}</span></span></label>`;
    const alt = navigator.platform.includes('Mac') ? '⌥Z' : 'Alt+Z';
    const indents = [...new Set([2, 4, c.indent])].sort((a, b) => a - b);
    this.content.innerHTML = `
      <section class="settings-section"><h3>${t('APPEARANCE')}</h3>
        ${row(t('Theme'), seg('theme', t('Theme'), [['vscode', t('Follow VS Code')], ['light', t('Light')], ['dark', t('Dark')], ['system', t('Follow system')]], c.theme))}
        ${row(t('Word wrap'), seg('wordWrap', t('Word wrap'), [['followEditor', t('Follow editor')], ['on', t('On')], ['off', t('Off')]], c.wordWrap), t('{0} toggles wrap in the open view.', alt))}
        ${row(t('Indent'), seg('indent', t('Indent'), indents.map((n) => [String(n), t('{0} spaces', n)]), String(c.indent)), t('Used by the views and the record editor.'))}
      </section>
      <section class="settings-section"><h3>${t('LANGUAGE')}</h3>
        <div class="settings-control">
          ${seg('language', t('LANGUAGE'), [['auto', t('Follow VS Code (current: {0})', languageName(c.vscodeLanguage))], ['en', 'English'], ['zh-cn', '简体中文']], c.language)}
          <span class="settings-hint">${esc(t('Right-click menus and the VS Code Settings editor always use the VS Code display language.'))}</span>
        </div>
      </section>
      <section class="settings-section"><h3>${t('VIEWS')}</h3>
        ${row(t('Default view'), seg('defaultView', t('Default view'), [['formatted', t('Formatted')], ['grid', t('Grid')], ['graph', t('Graph')]], c.defaultView))}
        ${row(t('JSON Lines'), seg('jsonl.expandMode', t('JSON Lines'), [['focus', t('Focus')], ['all', t('Expand all')]], c.expandMode), t('The mode a new view starts in.'))}
        ${row(t('Graph nodes'), `<input class="settings-num" type="number" min="50" max="20000" step="50" data-key="graph.maxNodes" value="${c.graphMaxNodes}" aria-label="${esc(t('Graph node limit'))}">`, t('The graph stops adding nodes after this number.'))}
      </section>
      <section class="settings-section"><h3>${t('TEXT EDITOR')}</h3>
        ${check('syncSelection', t('Sync the current line with the text editor'), c.syncSelection, t('Moving the cursor expands that line; clicking a line moves the cursor.'))}
        ${check('preview.followActiveEditor', t('The side preview follows the active editor'), c.followActiveEditor, t('It switches to the JSON or JSONL editor that becomes active.'))}
        ${check('formatDocument.enabled', t('Format Document compacts JSONL lines'), c.formatDocument, t('Off: Format Document does not change .jsonl files.'))}
        ${check('expandLines.showReminder', t('Remind me after Expand Selected Lines'), c.expandReminder, t('The file is not valid JSON Lines until you compact it.'))}
      </section>`;
  }

  private set(key: SettingKey, value: unknown): void {
    if (key === 'theme') {
      this.app.config = { ...this.app.config, theme: value as never };
      this.app.applyTheme();
    }
    this.app.post({ type: 'setSetting', key, value });
  }

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('.settings-seg .seg-btn') as HTMLElement | null;
    if (!btn) return;
    const group = btn.closest('.settings-seg') as HTMLElement;
    const key = group.dataset.key as SettingKey;
    const raw = btn.dataset.value as string;
    group.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('on', b === btn);
      b.setAttribute('aria-checked', String(b === btn));
    });
    this.set(key, key === 'indent' ? Number(raw) : raw);
  }

  private onChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const key = input.dataset.key as SettingKey | undefined;
    if (!key) return;
    if (input.type === 'checkbox') this.set(key, input.checked);
    else if (input.type === 'number') {
      const n = Math.round(Number(input.value));
      if (n >= 50 && n <= 20000) this.set(key, n);
      else input.value = String(this.app.config.graphMaxNodes);
    }
  }
}
