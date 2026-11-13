// Text for exported rows.

/** One CSV field (RFC 4180): quoted when it holds a quote, a comma, a line end, or space at an end. */
export function csvField(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}
