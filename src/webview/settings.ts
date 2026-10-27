import { languageName, t } from '../shared/i18n';
import type { SettingKey } from '../shared/protocol';
import type { App } from './app';
import { esc } from './json';
import { icon } from './icons';

type Option = [value: string, label: string];

/**
 * Settings drawer (like Git Map's). Every change is written to the VS Code user settings
 * by the extension host, so the panel and settings.json always agree.
 */
export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly content: HTMLElement;
  open = false;

  constructor(private readonly app: App) {
    this.el = document.createElement('div');
    this.el.className = 'settings';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('Better JSONL settings'));
    this.el.innerHTML = `
      <div class="settings-head"><h2>${t('Settings')}</h2><span class="dim">Better JSONL</span><button class="icon-btn settings-close" aria-label="${t('Close settings')}">${icon('close', 16)}</button></div>
      <div class="settings-content"></div>
      <div class="settings-foot"><span class="dim">${t('Saved to your VS Code user settings.')}</span><a href="#" class="settings-link">${t('Open in VS Code Settings')}</a></div>`;
    this.content = this.el.querySelector('.settings-content') as HTMLElement;
    this.el.querySelector('.settings-close')!.addEventListener('click', () => this.close());
    this.el.querySelector('.settings-link')!.addEventListener('click', (e) => {
      e.preventDefault();
      this.app.post({ type: 'openSettings' });
    });
    this.content.addEventListener('click', (e) => this.onClick(e));
    this.content.addEventListener('change', (e) => this.onChange(e));
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.refresh();
    this.el.classList.add('active');
    (this.el.querySelector('.settings-close') as HTMLElement).focus();
    this.app.scheduleReport();
  }

  close(): void {
    this.open = false;
    this.el.classList.remove('active');
    this.app.scheduleReport();
  }

  /** Re-renders from the current config (after a change from here or from settings.json). */
  refresh(): void {
    if (!this.open) return;
    const c = this.app.config;
    const seg = (key: SettingKey, options: Option[], selected: string) =>
      `<div class="seg settings-seg" role="radiogroup" data-key="${key}">${options
        .map(([v, label]) => `<button role="radio" class="seg-btn sub${v === selected ? ' on' : ''}" aria-checked="${v === selected}" data-value="${esc(v)}">${esc(label)}</button>`)
        .join('')}</div>`;
    const row = (label: string, control: string, hint = '') =>
      `<div class="settings-row"><span class="settings-label">${esc(label)}</span><div class="settings-control">${control}${hint ? `<span class="settings-hint">${esc(hint)}</span>` : ''}</div></div>`;
    const check = (key: SettingKey, label: string, value: boolean, hint: string) =>
      `<label class="settings-check"><input type="checkbox" data-key="${key}"${value ? ' checked' : ''}><span><span class="settings-check-label">${esc(label)}</span><span class="settings-hint">${esc(hint)}</span></span></label>`;
    const alt = navigator.platform.includes('Mac') ? '⌥Z' : 'Alt+Z';
    this.content.innerHTML = `
      <section class="settings-section"><h3>${t('APPEARANCE')}</h3>
        ${row(t('Theme'), seg('theme', [['vscode', t('Follow VS Code')], ['light', t('Light')], ['dark', t('Dark')], ['system', t('Follow system')]], c.theme))}
        ${row(t('Word wrap'), seg('wordWrap', [['followEditor', t('Follow editor')], ['on', t('On')], ['off', t('Off')]], c.wordWrap), t('{0} toggles wrap in the open view.', alt))}
        ${row(t('Indent'), seg('indent', [['2', t('{0} spaces', 2)], ['4', t('{0} spaces', 4)]], String(c.indent)), t('Used by the views and the record editor.'))}
      </section>
      <section class="settings-section"><h3>${t('LANGUAGE')}</h3>
        <div class="settings-control">
          ${seg('language', [['auto', t('Follow VS Code (current: {0})', languageName(c.vscodeLanguage))], ['en', 'English'], ['zh-cn', '简体中文']], c.language)}
          <span class="settings-hint">${esc(t('Right-click menus and the VS Code Settings editor always use the VS Code display language.'))}</span>
        </div>
      </section>
      <section class="settings-section"><h3>${t('VIEWS')}</h3>
        ${row(t('Default view'), seg('defaultView', [['formatted', t('Formatted')], ['grid', t('Grid')], ['graph', t('Graph')]], c.defaultView))}
        ${row(t('JSON Lines'), seg('jsonl.expandMode', [['focus', t('Focus')], ['all', t('Expand all')]], c.expandMode), t('The mode a new view starts in.'))}
        ${row(t('Graph nodes'), `<input class="settings-num" type="number" min="50" max="20000" step="50" data-key="graph.maxNodes" value="${c.graphMaxNodes}" aria-label="${esc(t('Graph node limit'))}">`, t('The graph stops adding nodes after this number.'))}
      </section>
      <section class="settings-section"><h3>${t('TEXT EDITOR')}</h3>
        ${check('syncSelection', t('Sync the current line with the text editor'), c.syncSelection, t('Moving the cursor expands that line; clicking a line moves the cursor.'))}
        ${check('formatDocument.enabled', t('Format Document compacts JSONL lines'), c.formatDocument, t('Off: Format Document does not change .jsonl files.'))}
        ${check('expandLines.showReminder', t('Remind me after Expand Selected Lines'), c.expandReminder, t('The file is not valid JSON Lines until you compact it.'))}
      </section>`;
  }

  private set(key: SettingKey, value: unknown): void {
    // Show theme changes at once; the host confirms with a config message.
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
