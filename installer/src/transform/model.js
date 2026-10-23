// @ts-check
/**
 * Turns the Consumption Central Fabric template (.pbit) into a semantic model definition for
 * Fabric: the template's own model, with its parameters filled in.
 */
import { readFileSync } from 'node:fs';
import { addCopilotPaygSpend } from './payg.js';
import { readZipEntry } from './zip.js';

/**
 * `definition.pbism` for a model defined by model.bim.
 * See https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/semantic-model-definition
 */
export const PBISM = {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
  version: '4.0',
  settings: {},
};

/**
 * @typedef {{ compatibilityLevel: number, model: { expressions?: { name: string, expression: string | string[], description?: string | string[] }[], tables: any[], annotations?: { name: string, value: string }[], [k: string]: any } }} ModelBim
 */

/**
 * A .pbit's DataModelSchema is usually UTF-16 with a byte-order mark.
 * @param {Buffer} raw
 */
export function decodeText(raw) {
  if (raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.subarray(3).toString('utf8');
  if (raw.length > 1 && raw[0] !== 0 && raw[1] === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

/**
 * Reads the model from a Power BI template.
 * @param {Buffer} pbit
 * @returns {ModelBim}
 */
export function readTemplateModel(pbit) {
  const schema = JSON.parse(decodeText(readZipEntry(pbit, 'DataModelSchema')));
  if (!schema?.model?.tables) throw new Error('The template has no data model.');
  return { compatibilityLevel: schema.compatibilityLevel, model: schema.model };
}

/** @param {string} file */
export const loadTemplateModel = (file) => readTemplateModel(readFileSync(file));

/**
 * Power Query text literal.
 * @param {string} value
 */
export const mString = (value) => `"${String(value).replace(/"/g, '""')}"`;

/**
 * Sets a Power Query parameter's value and keeps its `meta [...]` record.
 * @param {ModelBim['model']} model
 * @param {string} name
 * @param {string} value
 */
export function setMParameter(model, name, value) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) throw new Error(`The model has no "${name}" parameter.`);
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const at = text.indexOf(' meta [');
  if (at < 0) throw new Error(`"${name}" is not a parameter.`);
  expr.expression = `${mString(value)}${text.slice(at)}`;
}

/**
 * A Power Query number literal.
 * @param {number} value
 */
export function mNumber(value) {
  if (!Number.isFinite(value)) throw new Error(`${value} is not a number Power Query can read.`);
  return String(value);
}

/**
 * Sets a Number parameter's value and keeps its `meta [...]` record.
 * @param {ModelBim['model']} model
 * @param {string} name
 * @param {number} value
 */
export function setMNumberParameter(model, name, value) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) throw new Error(`The model has no "${name}" parameter.`);
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const at = text.indexOf(' meta [');
  if (at < 0) throw new Error(`"${name}" is not a parameter.`);
  if (!/Type="Number"/.test(text.slice(at))) throw new Error(`"${name}" is not a Number parameter.`);
  expr.expression = `${mNumber(value)}${text.slice(at)}`;
}

/**
 * A Number parameter's value, or undefined when there's no such parameter.
 * @param {ModelBim['model']} model
 * @param {string} name
 */
export function mNumberParameter(model, name) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) return undefined;
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const m = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?) meta \[[^\]]*Type="Number"/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * @param {ModelBim['model']} model
 * @param {string} name
 */
export function mParameter(model, name) {
  const expr = model.expressions?.find((e) => e.name === name);
  if (!expr) return undefined;
  const text = Array.isArray(expr.expression) ? expr.expression.join('\n') : String(expr.expression);
  const m = /^"((?:[^"]|"")*)" meta \[/.exec(text);
  return m ? m[1].replace(/""/g, '"') : undefined;
}

/**
 * @typedef {object} ModelSettings
 * @property {string} server  The Lakehouse's SQL analytics endpoint.
 * @property {string} database  The Lakehouse name.
 * @property {Record<string, number>} [prices]  Number parameters to set, by name (see prices.js). The rest keep the template's values.
 */

/**
 * The model to deploy. The template reads every table through GetTable, which gives null for one
 * that hasn't landed, so it deploys and refreshes before any data has. The template isn't modified.
 * @param {ModelBim} template
 * @param {ModelSettings} settings
 * @returns {ModelBim}
 */
export function buildModel(template, settings) {
  const model = structuredClone(template.model);
  setMParameter(model, 'FabricSQLEndpoint', settings.server);
  setMParameter(model, 'LakehouseName', settings.database);
  for (const [name, value] of Object.entries(settings.prices ?? {})) setMNumberParameter(model, name, value);
  addCopilotPaygSpend(model);
  return { compatibilityLevel: template.compatibilityLevel, model };
}

/**
 * The path Fabric uses to match the model's data source to a connection.
 * @param {string} server
 * @param {string} database
 */
export const datasourcePath = (server, database) => `${server};${database}`;
