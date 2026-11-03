const schemaPromise = fetch("./report-schema.json").then((response) => {
  if (!response.ok) throw new Error(`Report definition returned ${response.status}`);
  return response.json();
});
const definitionsPromise = fetch("./measure-definitions.json").then((response) => {
  if (!response.ok) throw new Error(`Measure definitions returned ${response.status}`);
  return response.json();
});

const fixtures = {
  groups: [
    { name: "Engineering", people: 34, credits: 18400, cost: 184 },
    { name: "Operations", people: 27, credits: 14200, cost: 142 },
    { name: "Finance", people: 18, credits: 8600, cost: 86 },
    { name: "Research", people: 21, credits: 12100, cost: 121 },
  ],
  agents: [
    { name: "Agent 01", credits: 8200, cost: 82 },
    { name: "Agent 02", credits: 5900, cost: 59 },
    { name: "Agent 03", credits: 3600, cost: 36 },
    { name: "Agent 04", credits: 2400, cost: 24 },
  ],
  models: [
    { name: "Model A", credits: 12100, cost: 121 },
    { name: "Model B", credits: 7800, cost: 78 },
    { name: "Model C", credits: 5300, cost: 53 },
    { name: "Model D", credits: 3100, cost: 31 },
  ],
  weeks: [
    { name: "May 04", credits: 6100 },
    { name: "May 11", credits: 6700 },
    { name: "May 18", credits: 6400 },
    { name: "May 25", credits: 7350 },
    { name: "Jun 01", credits: 7600 },
    { name: "Jun 08", credits: 8100 },
    { name: "Jun 15", credits: 7950 },
    { name: "Jun 22", credits: 8800 },
  ],
  products: [
    { name: "Cowork & Work IQ", credits: 52400, cost: 524 },
    { name: "Copilot Studio", credits: 31800, cost: 318 },
    { name: "GitHub Copilot", credits: 26900, cost: 269 },
    { name: "Azure AI Foundry", credits: 15400, cost: 154 },
  ],
};

const state = { pageIndex: 0, filters: {}, globalPeriod: "Current 4 weeks" };
const nav = document.querySelector("#page-nav");
const title = document.querySelector("#page-title");
const frame = document.querySelector("#report-frame");
const measureQuery = document.querySelector("#measure-query");
const measureResults = document.querySelector("#measure-results");
const globalPeriod = document.querySelector("#global-period");

globalPeriod.addEventListener("change", () => {
  state.globalPeriod = globalPeriod.value;
  renderPage();
});
measureQuery.addEventListener("input", () => renderMeasureSearch());

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function groupForPage(page) {
  const name = page.title.toLowerCase();
  if (name.includes("start here")) return "Start";
  if (name.includes("overall")) return "Overall";
  if (name.includes("cowork")) return "Cowork & Work IQ";
  if (name.includes("studio")) return "Copilot Studio";
  if (name.includes("azure")) return "Azure AI Foundry";
  if (name.includes("ghcp") || name.includes("github")) return "GitHub Copilot";
  return "Guide";
}

function renderNavigation(pages) {
  nav.replaceChildren();
  const groups = new Map();
  pages.forEach((page, index) => {
    const group = groupForPage(page);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ page, index });
  });
  for (const [label, items] of groups) {
    const section = el("section", "nav-group");
    section.append(el("h3", "", label));
    for (const { page, index } of items) {
      const button = el("button", "nav-page", page.title);
      button.type = "button";
      button.setAttribute("aria-current", index === state.pageIndex ? "page" : "false");
      button.addEventListener("click", () => {
        state.pageIndex = index;
        renderNavigation(pages);
        renderPage();
      });
      section.append(button);
    }
    nav.append(section);
  }
}

function filterOptions(label) {
  const key = label.toLowerCase();
  if (key.includes("period") || key.includes("window")) return ["All", "Current 4 weeks", "Last 8 weeks", "All history"];
  if (key.includes("scenario") || key.includes("growth")) return ["All", "Fitted from history", "Flat run rate", "Growth case"];
  if (key.includes("attribute") || key.includes("group")) return ["All", "Department", "Cost centre", "Region"];
  if (key.includes("department")) return ["All", ...fixtures.groups.map((row) => row.name)];
  if (key.includes("product")) return ["All", ...fixtures.products.map((row) => row.name)];
  if (key.includes("agent")) return ["All", ...fixtures.agents.map((row) => row.name)];
  if (key.includes("environment")) return ["All", "Environment 01", "Environment 02"];
  if (key.includes("model")) return ["All", ...fixtures.models.map((row) => row.name)];
  if (key.includes("status")) return ["All", "Matched", "Estimated", "Needs review"];
  if (key.includes("action")) return ["All", "Review", "Right-size", "Keep"];
  if (key.includes("type") || key.includes("service")) return ["All", "Category 01", "Category 02", "Category 03"];
  return ["All", "Option 01", "Option 02", "Option 03"];
}

function filterFactor() {
  const selected = Object.values(state.filters).filter((value) => value && value !== "All");
  if (!selected.length && state.globalPeriod === "Current 4 weeks") return 1;
  const seed = selected.join("|").split("").reduce((sum, char) => sum + char.charCodeAt(0), state.globalPeriod.length);
  return Math.max(0.58, Math.min(1.34, 0.82 + (seed % 47) / 100));
}

function numbersFor(page, visual) {
  const key = `${page.index}:${visual.index}:${Object.values(state.filters).join("|")}:${state.globalPeriod}`;
  let seed = 0;
  for (const char of key) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const factor = filterFactor();
  return Array.from({ length: 8 }, (_, index) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.max(8, Math.round((35 + (seed % 145)) * factor * (1 + index / 70)));
  });
}

function fieldDefinition(label, definitions) {
  if (!label) return "";
  const direct = definitions[label];
  if (direct) return direct;
  const normalized = label.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const match = Object.entries(definitions).find(([name]) =>
    name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "") === normalized,
  );
  return match?.[1] ?? "";
}

function addDefinition(container, label, definitions) {
  const description = fieldDefinition(label, definitions);
  if (!description) return;
  const details = el("details", "definition");
  const summary = el("summary", "", "i");
  summary.setAttribute("aria-label", `Definition for ${label}`);
  const text = el("p", "", description);
  details.append(summary, text);
  container.append(details);
}

function createVisual(page, visual, definitions) {
  const box = el("section", `visual ${visual.type}`);
  box.setAttribute("aria-label", visual.label || visual.type);
  const { x, y, width, height, z } = visual.position;
  const canvas = page.canvas;
  box.style.left = `${(x / canvas.width) * 100}%`;
  box.style.top = `${(y / canvas.height) * 100}%`;
  box.style.width = `${(width / canvas.width) * 100}%`;
  box.style.height = `${(height / canvas.height) * 100}%`;
  box.style.zIndex = String(Math.max(1, Math.round(z)));

  if (visual.type === "basicShape" || visual.type === "shape") {
    box.classList.add("shape");
    return box;
  }
  if (visual.type === "image") {
    box.classList.add("image-visual");
    box.append(el("div", "image-mark", "CC"));
    return box;
  }
  if (visual.type === "actionButton") {
    box.classList.add("action-visual");
    const button = el("button", "action", "How to read");
    button.type = "button";
    button.addEventListener("click", () => {
      const target = page.pages.findIndex((item) => item.title.toLowerCase() === "how to read this");
      if (target >= 0) {
        state.pageIndex = target;
        renderNavigation(page.pages);
        renderPage();
      }
    });
    box.append(button);
    return box;
  }

  const label = visual.label || fallbackTitle(visual.type);
  const heading = el("div", "visual-title");
  heading.append(el("span", "", label));
  addDefinition(heading, label, definitions);
  box.append(heading);

  if (visual.type === "slicer") {
    const wrap = el("div", "slicer");
    const selectLabel = el("label", "", label);
    const select = document.createElement("select");
    select.setAttribute("aria-label", `${label} filter`);
    const options = filterOptions(label);
    for (const option of options) {
      const item = el("option", "", option);
      item.value = option;
      select.append(item);
    }
    select.value = state.filters[label] || "All";
    select.addEventListener("change", () => {
      state.filters[label] = select.value;
      renderPage();
    });
    wrap.append(selectLabel, select);
    box.append(wrap);
  } else if (visual.type === "cardVisual") {
    const values = numbersFor(page, visual);
    const total = values.reduce((sum, value) => sum + value, 0);
    const looksLikeCost = /cost|spend|amount|price|bill/i.test(label);
    const value = looksLikeCost ? `$${(total / 22).toFixed(2)}` : total.toLocaleString("en-US");
    box.append(el("div", "metric", value), el("div", "metric-sub", "Illustrative value · synthetic data"));
  } else if (visual.type === "pivotTable") {
    box.append(makeTable(page, visual));
  } else if (["lineChart", "lineClusteredColumnComboChart", "lineStackedColumnComboChart", "clusteredBarChart", "barChart", "columnChart", "funnel"].includes(visual.type)) {
    box.append(makeChart(page, visual));
  } else {
    box.append(el("p", "copy", introCopy(page)));
  }
  return box;
}

function fallbackTitle(type) {
  const labels = {
    cardVisual: "Summary",
    pivotTable: "Detail",
    lineChart: "Trend",
    clusteredBarChart: "Comparison",
    barChart: "Comparison",
    columnChart: "Usage by period",
    funnel: "Breakdown",
  };
  return labels[type] || "Report visual";
}

function introCopy(page) {
  const name = page.title.toLowerCase();
  if (name.includes("start here")) return "Explore the report pages using the navigation and filters. All figures are invented for this browser demo.";
  if (name.includes("glossary") || name.includes("read")) return "Select the information icon on a measure to see its source definition. Search for any measure above.";
  return "This visual follows the report's layout. Values are illustrative and respond to local filters.";
}

function makeTable(page, visual) {
  const wrap = el("div", "table-wrap");
  const table = document.createElement("table");
  const labels = visual.fields.length ? visual.fields.slice(0, 4) : ["Group", "Credits", "Cost"];
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  for (const label of labels) row.append(el("th", "", label));
  head.append(row);
  const body = document.createElement("tbody");
  const rows = /agent/i.test(labels.join(" ")) ? fixtures.agents : /model/i.test(labels.join(" ")) ? fixtures.models : fixtures.groups;
  const factor = filterFactor();
  rows.forEach((source, rowIndex) => {
    const tr = document.createElement("tr");
    const name = source.name || `Group ${String(rowIndex + 1).padStart(2, "0")}`;
    tr.dataset.selectable = "true";
    tr.title = "Select this row to apply a local group filter";
    tr.addEventListener("click", () => {
      state.filters.Group = name;
      renderPage();
    });
    labels.forEach((label, columnIndex) => {
      const cell = document.createElement("td");
      if (columnIndex === 0) cell.textContent = name;
      else if (/cost|amount|price|spend|value/i.test(label)) cell.textContent = `$${(source.cost * factor).toFixed(2)}`;
      else if (/people|user|dev|count|agent/i.test(label)) cell.textContent = String(source.people || rowIndex + 1);
      else cell.textContent = Math.round((source.credits || 1000) * factor).toLocaleString("en-US");
      tr.append(cell);
    });
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function makeChart(page, visual) {
  const wrap = el("div", "chart");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 150");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${visual.label || "Synthetic chart"} with invented values`);
  const values = numbersFor(page, visual);
  const max = Math.max(...values) * 1.15;
  for (let grid = 1; grid <= 3; grid++) {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", "28");
    line.setAttribute("x2", "312");
    line.setAttribute("y1", String(20 + grid * 30));
    line.setAttribute("y2", String(20 + grid * 30));
    line.setAttribute("class", "grid-line");
    svg.append(line);
  }
  const isLine = visual.type.toLowerCase().includes("line");
  const labels = fixtures.weeks.slice(0, values.length).map((item) => item.name);
  if (isLine) {
    const points = values.map((value, index) => `${34 + index * 38},${126 - (value / max) * 100}`).join(" ");
    const polyline = document.createElementNS(svg.namespaceURI, "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("class", "line");
    svg.append(polyline);
    values.forEach((value, index) => {
      const circle = document.createElementNS(svg.namespaceURI, "circle");
      circle.setAttribute("cx", String(34 + index * 38));
      circle.setAttribute("cy", String(126 - (value / max) * 100));
      circle.setAttribute("r", "3");
      circle.setAttribute("fill", "#176f65");
      circle.setAttribute("title", `${labels[index]}: ${value}`);
      svg.append(circle);
    });
  } else {
    values.slice(0, 7).forEach((value, index) => {
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      const barHeight = (value / max) * 104;
      rect.setAttribute("x", String(35 + index * 38));
      rect.setAttribute("y", String(126 - barHeight));
      rect.setAttribute("width", "23");
      rect.setAttribute("height", String(barHeight));
      rect.setAttribute("rx", "2");
      rect.setAttribute("class", index % 2 ? "bar alt" : "bar");
      rect.setAttribute("title", `${labels[index]}: ${value}`);
      svg.append(rect);
    });
  }
  labels.forEach((label, index) => {
    const text = document.createElementNS(svg.namespaceURI, "text");
    text.setAttribute("x", String(32 + index * 38));
    text.setAttribute("y", "144");
    text.setAttribute("class", "chart-label");
    text.textContent = label;
    svg.append(text);
  });
  wrap.append(svg);
  return wrap;
}

function renderMeasureSearch() {
  if (!definitions) return;
  const query = measureQuery.value.trim().toLocaleLowerCase();
  measureResults.replaceChildren();
  if (query.length < 2) return;
  const matches = Object.entries(definitions)
    .filter(([name, description]) => `${name} ${description}`.toLocaleLowerCase().includes(query))
    .slice(0, 8);
  for (const [name, description] of matches) {
    const hit = el("article", "measure-hit");
    hit.append(el("strong", "", name), el("p", "", description));
    measureResults.append(hit);
  }
  if (!matches.length) measureResults.append(el("div", "measure-hit", "No matching measure definition."));
}

let pages = [];
let definitions = {};

function renderPage() {
  const page = pages[state.pageIndex];
  if (!page) return;
  title.textContent = page.title;
  const canvas = el("div", "report-canvas");
  canvas.style.aspectRatio = `${page.canvas.width} / ${page.canvas.height}`;
  canvas.setAttribute("aria-label", `${page.title} report visuals`);
  page.pages = pages;
  page.visuals.forEach((visual) => canvas.append(createVisual(page, visual, definitions)));
  frame.replaceChildren(canvas);
}

async function start() {
  const [schema, measureMap] = await Promise.all([schemaPromise, definitionsPromise]);
  pages = schema.pages;
  definitions = measureMap;
  renderNavigation(pages);
  renderPage();
  renderMeasureSearch();
}

start().catch((error) => {
  const message = el("div", "error", `The static report could not load its local definition: ${error.message}`);
  document.querySelector(".report-main").replaceChildren(message);
});
