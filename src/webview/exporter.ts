// Text for exported rows (CSV and Markdown tables).

/** One CSV field (RFC 4180): quoted when it holds a quote, a comma, a line end, or space at an end. */
export function csvField(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

/** One Markdown table cell: pipes escaped and line breaks rendered as `<br>`. */
export function mdField(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function mdRow(fields: string[]): string {
  return `| ${fields.map(mdField).join(' | ')} |`;
}

export function mdDivider(cols: number): string {
  return `| ${Array.from({ length: Math.max(1, cols) }, () => '---').join(' | ')} |`;
}
