// @ts-check
/**
 * Tables the installer adds to a model at deploy time, so the templates stay as they are. Before
 * the first load the tables are there but empty, so queries against them never fail.
 */
import { createHash } from 'node:crypto';

/** @typedef {'date' | 'datetime' | 'text' | 'count' | 'flag'} ArgColumnKind */
/** @typedef {{ name: string, source: string, description: string, columns: { name: string, kind: ArgColumnKind }[] }} ArgTable */

/** @param {string} spec  Space-separated names; a suffix of `:date`, `:datetime`, `:flag` or `:count` sets the kind. */
export const cols = (spec) =>
  spec.split(/\s+/).filter(Boolean).map((s) => {
    const [name, kind = 'text'] = s.split(':');
    return { name, kind: /** @type {ArgColumnKind} */ (kind) };
  });

/**
 * A stable GUID for an object the installer adds, so redeploys don't churn lineage.
 * @param {string} key
 */
export function stableGuid(key) {
  const h = createHash('sha1').update(`valuelens:arg:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const M_TYPES = /** @type {Record<ArgColumnKind, string>} */ ({ date: 'type date', datetime: 'type datetime', text: 'type text', count: 'Int64.Type', flag: 'type logical' });

/**
 * The partition's Power Query. `source` is the M that reads the Lakehouse table; without it the table is empty.
 * @param {ArgTable} t
 * @param {string[] | null} source
 */
function partitionExpression(t, source) {
  const names = `{${t.columns.map((c) => `"${c.name}"`).join(', ')}}`;
  const types = t.columns.map((c) => `{"${c.name}", ${M_TYPES[c.kind]}}`).join(', ');
  return [
    'let',
    `    Columns = ${names},`,
    ...(source ?? ['    Source = #table(Columns, {}),']),
    '    Kept = Table.SelectColumns(Source, Columns, MissingField.UseNull),',
    `    Typed = Table.TransformColumnTypes(Kept, {${types}})`,
    'in',
    '    Typed',
  ];
}

/**
 * For the ValueLens model, which reads tables with FabricTable.
 * @param {ArgTable} t
 * @param {boolean} on
 */
export const valueLensExpression = (t, on) =>
  partitionExpression(t, on ? [`    Source = try FabricTable("${t.source}") otherwise EmptyTable(Columns),`] : null);

/**
 * @param {string} table
 * @param {{ name: string, kind: ArgColumnKind }} c
 */
function column(table, c) {
  const base = { name: c.name, sourceColumn: c.name, lineageTag: stableGuid(`column:${table}:${c.name}`) };
  /** @type {{ name: string, value: string }[]} */
  const annotations = [{ name: 'SummarizationSetBy', value: 'Automatic' }];
  if (c.kind === 'date') {
    annotations.push({ name: 'UnderlyingDateTimeDataType', value: 'Date' });
    return { ...base, dataType: 'dateTime', formatString: 'Long Date', summarizeBy: 'none', annotations };
  }
  if (c.kind === 'datetime') return { ...base, dataType: 'dateTime', formatString: 'General Date', summarizeBy: 'none', annotations };
  if (c.kind === 'flag') return { ...base, dataType: 'boolean', formatString: '"TRUE";"TRUE";"FALSE"', summarizeBy: 'none', annotations };
  if (c.kind === 'count') return { ...base, dataType: 'int64', formatString: '#,0', summarizeBy: 'sum', annotations };
  return { ...base, dataType: 'string', summarizeBy: 'none', annotations };
}

/**
 * @param {import('./model.js').ModelBim['model']} model
 * @param {ArgTable} t
 * @param {string[]} expression
 * @param {string} from  Ends the table's description.
 */
export function addTable(model, t, expression, from) {
  model.tables.push({
    name: t.name,
    description: `${t.description} ${from}`,
    lineageTag: stableGuid(`table:${t.name}`),
    columns: t.columns.map((c) => column(t.name, c)),
    partitions: [{ name: t.name, mode: 'import', source: { type: 'm', expression } }],
    annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
  });
}
