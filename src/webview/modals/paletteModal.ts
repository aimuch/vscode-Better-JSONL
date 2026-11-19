// Modular In-View Command Palette & Keyboard Shortcut Cheat-Sheet (Cmd/Ctrl+Shift+P or ?).
import { t } from '../../shared/i18n';
import { esc } from '../json';
import { trapModalTabKey } from '../stateMachines';

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  category: string;
  run: () => void;
}

export class CommandPaletteModal {
  readonly el: HTMLElement;
  private commands: PaletteCommand[] = [];
  private filtered: PaletteCommand[] = [];
  private activeIdx = 0;

  constructor(private readonly onClose: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'modal-panel palette-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', t('Command palette & shortcuts'));
    this.el.hidden = true;
    this.el.addEventListener('keydown', (e) => {
      trapModalTabKey(this.el, e);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.filtered.length) {
          this.activeIdx = (this.activeIdx + 1) % this.filtered.length;
          this.paintList();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.filtered.length) {
          this.activeIdx = (this.activeIdx - 1 + this.filtered.length) % this.filtered.length;
          this.paintList();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = this.filtered[this.activeIdx];
        if (cmd) {
          this.onClose();
          cmd.run();
        }
      }
    });
  }

  open(commands: PaletteCommand[]): void {
    this.commands = commands;
    this.filtered = commands;
    this.activeIdx = 0;
    this.el.innerHTML = `
      <div class="pal-head">
        <input type="search" class="pal-input" placeholder="${esc(t('Type a command or view shortcuts…'))}" aria-label="${esc(t('Search commands'))}" spellcheck="false">
      </div>
      <div class="pal-list" role="listbox"></div>`;
    const input = this.el.querySelector('.pal-input') as HTMLInputElement;
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      this.filtered = q
        ? this.commands.filter(
            (c) =>
              c.label.toLowerCase().includes(q) ||
              c.category.toLowerCase().includes(q) ||
              (c.shortcut ?? '').toLowerCase().includes(q),
          )
        : this.commands;
      this.activeIdx = 0;
      this.paintList();
    });
    this.el.hidden = false;
    this.paintList();
    input.focus();
  }

  private paintList(): void {
    const list = this.el.querySelector('.pal-list') as HTMLElement | null;
    if (!list) return;
    if (!this.filtered.length) {
      list.innerHTML = `<div class="empty-note">${esc(t('No matching command.'))}</div>`;
      return;
    }
    list.innerHTML = this.filtered
      .map(
        (c, i) =>
          `<button class="pal-item${i === this.activeIdx ? ' active' : ''}" role="option" aria-selected="${i === this.activeIdx}" data-pidx="${i}">
            <span class="pal-cat dim">${esc(c.category)}</span>
            <span class="pal-lbl">${esc(c.label)}</span>
            ${c.shortcut ? `<kbd class="pal-kbd">${esc(c.shortcut)}</kbd>` : ''}
          </button>`,
      )
      .join('');
    list.querySelectorAll<HTMLButtonElement>('[data-pidx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = this.filtered[Number(btn.dataset.pidx)];
        if (cmd) {
          this.onClose();
          cmd.run();
        }
      });
    });
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
