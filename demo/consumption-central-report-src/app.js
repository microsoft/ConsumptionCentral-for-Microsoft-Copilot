import { defaultSelection, optionsFor, queryVisual, verifyBindings } from "./runtime";

const state = { pageIndex: 0, selections: new Map(), trail: [] };
const nav = document.querySelector("#page-nav");
const title = document.querySelector("#page-title");
const frame = document.querySelector("#report-frame");
const search = document.querySelector("#measure-query");
const results = document.querySelector("#measure-results");
let schema;
let definitions;

function el(tag, className = "", text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selection() {
  const id = schema.pages[state.pageIndex].id;
  if (!state.selections.has(id)) state.selections.set(id, defaultSelection());
  return state.selections.get(id);
}

function format(value, projection) {
  if (value === null) return "\u2014";
  if (typeof value !== "number") return value;
  const pattern = schema.measures[projection.ref]?.format || "";
  const percent = pattern.includes("%");
  const currency = pattern.includes("$");
  const decimals = (pattern.match(/\.(0+)/)?.[1] || "").length;
  return new Intl.NumberFormat("en-US", {
    ...(percent ? { style: "percent" } : currency ? { style: "currency", currency: "USD" } : {}),
    minimumFractionDigits: decimals,
    maximumFractionDigits: pattern ? decimals : (Number.isInteger(value) ? 0 : 2),
  }).format(value);
}

function cellValue(node, projection, value) {
  node.dataset.measure = projection.ref;
  node.dataset.value = JSON.stringify(value);
  node.textContent = format(value, projection);
  return node;
}

function info(projection) {
  const name = projection.ref.slice(projection.ref.indexOf(".") + 1);
  const description = definitions[name];
  if (!description) return null;
  const details = el("details", "definition");
  const summary = el("summary", "", "i");
  summary.setAttribute("aria-label", `Definition for ${projection.label}`);
  details.append(summary, el("p", "", description));
  return details;
}

function selectPage(id, remember = true) {
  const index = schema.pages.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`Unknown source page ${id}`);
  if (remember && index !== state.pageIndex) state.trail.push(schema.pages[state.pageIndex].id);
  state.pageIndex = index;
  history.replaceState(null, "", `#${id}`);
  renderNav();
  renderPage();
}

function renderNav() {
  nav.replaceChildren();
  schema.pages.forEach((page, index) => {
    const button = el("button", "nav-page", page.title);
    button.type = "button";
    button.dataset.page = page.id;
    button.setAttribute("aria-current", index === state.pageIndex ? "page" : "false");
    button.addEventListener("click", () => selectPage(page.id));
    nav.append(button);
  });
}

function renderText(visual, box) {
  box.classList.add("source-text");
  for (const paragraph of visual.paragraphs) {
    const p = el("p");
    for (const run of paragraph.textRuns || []) {
      const span = el("span", "", run.value);
      const style = run.textStyle || {};
      if (style.fontWeight) span.style.fontWeight = style.fontWeight;
      if (style.fontSize) span.style.fontSize = style.fontSize;
      if (style.color) span.style.color = style.color;
      p.append(span);
    }
    if (!p.textContent) p.append(document.createElement("br"));
    box.append(p);
  }
}

function renderSlicer(visual, box) {
  const projection = visual.roles.Values[0];
  const ref = projection.ref;
  const label = el("label", "slicer");
  label.append(el("span", "", projection.label));
  const selections = selection();
  if (ref === "Reporting Date.Date") {
    for (const [key, caption] of [["from", "From"], ["to", "To"]]) {
      const dateLabel = el("label", "date-label", caption);
      const input = document.createElement("input");
      input.type = "date";
      input.setAttribute("aria-label", `Reporting ${caption.toLowerCase()}`);
      input.value = selections[key] || (key === "from" ? "2026-05-01" : "2026-07-31");
      input.addEventListener("change", () => { selections[key] = input.value; renderPage(); });
      dateLabel.append(input);
      label.append(dateLabel);
    }
  } else {
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${projection.label} filter`);
    select.dataset.filter = ref;
    const choices = optionsFor(ref);
    for (const { value, label: caption } of choices) {
      const option = el("option", "", caption);
      option.value = value;
      select.append(option);
    }
    select.value = selections[ref] ?? choices[0]?.value ?? "";
    select.addEventListener("change", () => { selections[ref] = select.value; renderPage(); });
    label.append(select);
  }
  box.append(label);
}

function makeTable(data, totals = true) {
  const wrap = el("div", "table-wrap");
  const table = el("table");
  const head = el("thead");
  const header = el("tr");
  for (const p of [...data.dimensions, ...data.columns]) {
    const th = el("th", "", p.label);
    th.scope = "col";
    header.append(th);
  }
  head.append(header);
  table.append(head);
  const body = el("tbody");
  for (const row of data.rows) {
    const tr = el("tr");
    for (const label of row.labels) tr.append(el("td", "", label));
    row.values.forEach((value, i) => tr.append(cellValue(el("td", "numeric"), data.columns[i], value)));
    body.append(tr);
  }
  table.append(body);
  if (totals && data.dimensions.length && data.totals.length === data.columns.length) {
    const foot = el("tfoot");
    const tr = el("tr");
    data.dimensions.forEach((_, i) => tr.append(el("th", "", i === 0 ? "Total" : "")));
    data.totals.forEach((value, i) => tr.append(cellValue(el("td", "numeric"), data.columns[i], value)));
    foot.append(tr);
    table.append(foot);
  }
  wrap.append(table);
  return wrap;
}

const COLORS = ["#4f73b8", "#0b2c57", "#74a7aa", "#c79a54", "#824f86", "#609047"];
function svgNode(tag, attrs, parent, text) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, String(value));
  if (text !== undefined) n.textContent = text;
  parent.append(n);
  return n;
}

function renderChart(visual, data, box) {
  const wrap = el("div", "chart");
  const chartWidth = Math.max(240, visual.position.width - 12);
  const chartHeight = Math.max(180, visual.position.height - 48);
  const svg = svgNode("svg", { viewBox: `0 0 ${chartWidth} ${chartHeight}`, role: "img", "aria-label": visual.label || data.columns.map((p) => p.label).join(", ") }, wrap);
  const horizontal = ["clusteredBarChart", "barChart", "funnel"].includes(visual.type);
  const line = visual.type === "lineChart";
  const combo = visual.type.includes("Combo");
  const stacked = ["barChart", "columnChart", "lineStackedColumnComboChart"].includes(visual.type);
  const numeric = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const rows = data.rows;
  if (!rows.length) {
    box.append(el("p", "empty", "No records match these filters."));
    return;
  }
  const tooltip = (row, column, value) => `${row.labels.join(" / ")}\n${column.label}: ${format(value, column)}\n${row.tooltips.map((p) => `${p.label}: ${p.value ?? "\u2014"}`).join("\n")}`;
  const max1 = Math.max(0, ...rows.map((r) => stacked ? r.values.slice(0, combo ? visual.roles.Y.length : r.values.length).reduce((n, v) => n + numeric(v), 0) : Math.max(0, ...r.values.slice(0, combo ? visual.roles.Y.length : r.values.length).map(numeric)))) || 1;
  const min1 = Math.min(0, ...rows.flatMap((r) => r.values.slice(0, combo ? visual.roles.Y.length : r.values.length).map(numeric)));
  const max2 = Math.max(0, ...rows.flatMap((r) => r.values.slice(visual.roles.Y?.length || 0).map(numeric))) || 1;
  const short = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : String(value);
  const x0 = horizontal ? Math.max(76, Math.min(155, chartWidth * .28)) : 55;
  const width = chartWidth - x0 - (combo ? 64 : 20);
  const labelEvery = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(width / 60))));
  const y0 = 18, height = chartHeight - 62;
  const y = (v, second = false) => y0 + height - ((v - (second ? 0 : min1)) / (second ? max2 : max1 - min1)) * height;
  const x = (v) => x0 + (v - min1) / (max1 - min1) * width;
  for (let tick = 0; tick <= 4; tick++) {
    const value = min1 + (max1 - min1) * tick / 4;
    if (horizontal) {
      svgNode("line", { x1: x(value), x2: x(value), y1: y0, y2: y0 + height, class: "grid-line" }, svg);
      svgNode("text", { x: x(value), y: y0 + height + 18, "text-anchor": "middle", class: "chart-label" }, svg, format(value, data.columns[0]));
    } else {
      svgNode("line", { x1: x0, x2: x0 + width, y1: y(value), y2: y(value), class: "grid-line" }, svg);
      svgNode("text", { x: x0 - 5, y: y(value) + 4, "text-anchor": "end", class: "chart-label" }, svg, format(value, data.columns[0]));
      if (combo) svgNode("text", { x: x0 + width + 5, y: y(max2 * tick / 4, true) + 4, class: "chart-label" }, svg, format(max2 * tick / 4, data.columns.at(-1)));
    }
  }
  data.columns.forEach((column, series) => {
    const second = combo && series >= visual.roles.Y.length;
    const useLine = line || second;
    const points = [];
    rows.forEach((row, i) => {
      const value = numeric(row.values[series]);
      const step = (horizontal ? height : width) / rows.length;
      const center = (horizontal ? y0 : x0) + step * (i + .5);
      const color = COLORS[series % COLORS.length];
      let mark;
      if (useLine) {
        points.push(`${center},${y(value, second)}`);
        mark = svgNode("circle", { cx: center, cy: y(value, second), r: 3, fill: color }, svg);
      } else if (visual.type === "funnel") {
        const w = value / max1 * width;
        const h = Math.max(6, step - 3);
        const cx = x0 + width / 2;
        mark = svgNode("polygon", { points: `${cx - w / 2},${center - h / 2} ${cx + w / 2},${center - h / 2} ${cx + w * .42},${center + h / 2} ${cx - w * .42},${center + h / 2}`, fill: COLORS[i % COLORS.length] }, svg);
      } else {
        const prior = stacked ? row.values.slice(0, series).reduce((n, v) => n + numeric(v), 0) : 0;
        const bands = stacked ? 1 : (combo ? visual.roles.Y.length : data.columns.length);
        const band = step * .7 / bands;
        const position = center - step * .35 + (stacked ? 0 : series * band);
        mark = horizontal
          ? svgNode("rect", { x: Math.min(x(prior), x(prior + value)), y: position, width: Math.abs(x(prior + value) - x(prior)), height: Math.max(1, band - 1), fill: color }, svg)
          : svgNode("rect", { x: position, y: Math.min(y(prior), y(prior + value)), width: Math.max(1, band - 1), height: Math.abs(y(prior) - y(prior + value)), fill: color }, svg);
      }
      mark.dataset.measure = column.ref;
      mark.dataset.value = JSON.stringify(row.values[series]);
      svgNode("title", {}, mark, tooltip(row, column, row.values[series]));
      if (series === 0 && (horizontal || i % labelEvery === 0)) {
        const caption = short(row.labels.join(" / "));
        const limit = horizontal ? Math.max(10, Math.floor(x0 / 5.2)) : 26;
        svgNode("text", horizontal
          ? { x: x0 - 6, y: center + 3, "text-anchor": "end", class: "chart-label" }
          : { x: center, y: y0 + height + 18, "text-anchor": "middle", class: "chart-label" }, svg, caption.length > limit ? caption.slice(0, limit - 2) + "\u2026" : caption);
      }
    });
    if (useLine) svgNode("polyline", { points: points.join(" "), fill: "none", stroke: COLORS[series % COLORS.length], "stroke-width": 2 }, svg);
  });
  const legend = el("div", "chart-legend");
  data.columns.forEach((p, i) => {
    const item = el("span", "", `${combo && i >= visual.roles.Y.length ? "Line / right axis: " : ""}${p.label}`);
    item.style.setProperty("--series-color", COLORS[i % COLORS.length]);
    legend.append(item);
  });
  const details = el("details", "chart-data");
  details.append(el("summary", "", "Show data"), makeTable(data, false));
  box.append(wrap, legend, details);
}

function renderVisual(visual) {
  const box = el("section", `visual ${visual.type}`);
  box.dataset.visual = visual.id;
  box.dataset.visualType = visual.type;
  box.setAttribute("aria-label", visual.label || visual.type);
  const { x, y, width, height, z } = visual.position;
  Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`, zIndex: z });
  if (["shape", "basicShape"].includes(visual.type)) {
    box.classList.add("shape");
    box.style.background = visual.fill || "#fff";
    return box;
  }
  if (visual.type === "textbox") { renderText(visual, box); return box; }
  if (visual.type === "image") {
    const img = document.createElement("img");
    img.src = visual.image;
    img.alt = "Copilot";
    box.append(img);
    return box;
  }
  if (visual.type === "actionButton") {
    if (visual.action === "Back") {
      const button = el("button", "source-action", "\u2190");
      button.type = "button";
      button.setAttribute("aria-label", "Back to previous report page");
      button.addEventListener("click", () => selectPage(state.trail.pop() || schema.pages[0].id, false));
      box.append(button);
      return box;
    }
    const target = schema.pages.find((p) => p.id === visual.target);
    if (!target) throw new Error(`Unsupported navigation in ${visual.id}`);
    const button = el("button", "source-action", "?");
    button.type = "button";
    button.setAttribute("aria-label", target.title);
    button.addEventListener("click", () => selectPage(target.id));
    box.append(button);
    return box;
  }
  if (visual.type === "slicer") { renderSlicer(visual, box); return box; }
  const data = queryVisual(visual, selection());
  if (visual.type === "cardVisual") {
    const cards = el("div", "cards");
    data.columns.forEach((p, i) => {
      const value = data.totals[i];
      const tile = el("article", typeof value === "string" ? "metric-tile narrative" : "metric-tile");
      tile.append(cellValue(el("div", "metric"), p, value));
      const label = el("div", "metric-label", p.label);
      const definition = info(p);
      if (definition) label.append(definition);
      tile.append(label);
      cards.append(tile);
    });
    box.append(cards);
  } else {
    if (visual.label) box.append(el("div", "visual-title", visual.label));
    if (visual.type === "pivotTable") box.append(makeTable(data));
    else renderChart(visual, data, box);
  }
  return box;
}

let observer;
function renderPage() {
  const page = schema.pages[state.pageIndex];
  title.textContent = page.title;
  const canvas = el("div", "report-canvas");
  canvas.setAttribute("aria-label", `${page.title} source report canvas`);
  canvas.style.width = `${page.canvas.width}px`;
  canvas.style.height = `${page.canvas.height}px`;
  page.visuals.forEach((v) => canvas.append(renderVisual(v)));
  frame.replaceChildren(canvas);
  observer?.disconnect();
  const scale = () => {
    const ratio = Math.min(1, (frame.clientWidth - 2) / page.canvas.width);
    canvas.style.transform = `scale(${ratio})`;
    frame.style.height = `${page.canvas.height * ratio + 2}px`;
  };
  observer = new ResizeObserver(scale);
  observer.observe(frame);
  scale();
}

function renderSearch() {
  results.replaceChildren();
  const query = search.value.trim().toLowerCase();
  if (query.length < 2) return;
  for (const [name, description] of Object.entries(definitions).filter(([name, description]) => `${name} ${description}`.toLowerCase().includes(query)).slice(0, 8)) {
    const hit = el("article", "measure-hit");
    hit.append(el("strong", "", name), el("p", "", description));
    results.append(hit);
  }
  if (!results.childElementCount) results.append(el("p", "measure-hit", "No matching measure definition."));
}

document.querySelector("#reset-filters").addEventListener("click", () => {
  state.selections.delete(schema.pages[state.pageIndex].id);
  renderPage();
});
search.addEventListener("input", renderSearch);

async function load(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function start() {
  [schema, definitions] = await Promise.all([load("./report-schema.json"), load("./measure-definitions.json")]);
  verifyBindings(schema.pages);
  const selected = schema.pages.find((p) => p.id === location.hash.slice(1));
  selectPage(selected?.id || schema.pages[0].id);
}
start().catch((error) => {
  console.error(error);
  document.querySelector(".report-main").replaceChildren(el("p", "error", `The report demo could not load: ${error.message}`));
});
