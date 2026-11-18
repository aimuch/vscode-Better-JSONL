// Text for exported rows (CSV, TSV, Markdown tables, and SQL CREATE/INSERT statements).
import { isContainer, RawNum, type JVal } from './json';
import { compactJson } from './query';

/** One CSV field (RFC 4180): quoted when it holds a quote, a comma, a line end, or space at an end. */
export function csvField(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}

/** One TSV cell: tabs and line breaks normalized to single spaces so paste into Excel / Sheets never shifts columns. */
export function tsvField(s: string): string {
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

export function tsvRow(fields: string[]): string {
  return fields.map(tsvField).join('\t');
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

export type SqlColType = 'BIGINT' | 'DOUBLE PRECISION' | 'BOOLEAN' | 'JSON' | 'TEXT';

export function sqlIdent(name: string): string {
  const clean = name || 'value';
  return `"${clean.replace(/"/g, '""')}"`;
}

export function sqlLiteral(v: JVal | undefined): string {
  if (v === undefined || v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (v instanceof RawNum) return /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v.src) ? v.src : `'${v.src.replace(/'/g, "''")}'`;
  if (isContainer(v)) return `'${compactJson(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export function inferSqlColumnTypes(colCount: number, sampleRows: (JVal | undefined)[][]): SqlColType[] {
  return Array.from({ length: colCount }, (_, colIdx) => {
    let sawInt = false;
    let sawFloat = false;
    let sawBool = false;
    let sawJson = false;
    let sawText = false;
    for (const row of sampleRows) {
      const v = row[colIdx];
      if (v === undefined || v === null) continue;
      if (typeof v === 'boolean') sawBool = true;
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) sawInt = true;
        else sawFloat = true;
      } else if (v instanceof RawNum) {
        if (/^[+-]?\d+$/.test(v.src) && v.src.replace(/^[+-]/, '').length <= 18) sawInt = true;
        else if (/[.eE]/.test(v.src)) sawFloat = true;
        else sawText = true;
      } else if (isContainer(v)) sawJson = true;
      else sawText = true;
    }
    const kinds = Number(sawInt || sawFloat) + Number(sawBool) + Number(sawJson) + Number(sawText);
    if (kinds !== 1) return 'TEXT';
    if (sawFloat) return 'DOUBLE PRECISION';
    if (sawInt) return 'BIGINT';
    if (sawBool) return 'BOOLEAN';
    if (sawJson) return 'JSON';
    return 'TEXT';
  });
}

export function sqlCreateTable(tableName: string, headers: string[], types: SqlColType[]): string {
  const safeTable = sqlIdent(tableName.replace(/[^A-Za-z0-9_]/g, '_') || 'records');
  const defs = headers.map((h, i) => `  ${sqlIdent(h)} ${types[i] ?? 'TEXT'}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS ${safeTable} (\n${defs}\n);\n`;
}

export function sqlInsertBatch(tableName: string, headers: string[], rows: (JVal | undefined)[][]): string {
  if (!rows.length) return '';
  const safeTable = sqlIdent(tableName.replace(/[^A-Za-z0-9_]/g, '_') || 'records');
  const cols = headers.map(sqlIdent).join(', ');
  const tuples = rows.map((r) => `  (${headers.map((_, i) => sqlLiteral(r[i])).join(', ')})`).join(',\n');
  return `INSERT INTO ${safeTable} (${cols}) VALUES\n${tuples};\n`;
}
