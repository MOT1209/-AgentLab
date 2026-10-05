import { STRINGS } from "./i18n.js";

let lang = "en";
try {
  lang = localStorage.getItem("lang") === "ar" ? "ar" : "en";
} catch {
  /* storage unavailable: default to English */
}
let tab = "devices";
const t = () => STRINGS[lang];

// Every dynamic value goes through textContent, never innerHTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function msg(kind, text) {
  return el("div", { class: `msg ${kind}`, role: kind === "err" ? "alert" : "status" }, text);
}

// ---- Devices ---------------------------------------------------------------------------------

async function renderDevices(root) {
  const out = el("div");
  const table = el("div", { class: "tablewrap" });
  async function load() {
    const { data } = await api("GET", "/devices");
    table.replaceChildren();
    if (!Array.isArray(data) || data.length === 0) {
      table.append(msg("warn", t().noDevices));
      return;
    }
    const head = el("tr", {}, ...[t().colId, t().colSerial, t().colModel, t().colState, t().colLock, t().colAssigned].map((h) => el("th", {}, h)));
    const rows = data.map((d) =>
      el("tr", {}, el("td", {}, d.id ?? ""), el("td", {}, d.serial ?? ""), el("td", {}, d.model ?? ""), el("td", {}, d.state ?? ""), el("td", {}, d.lock ?? ""), el("td", {}, d.assignedAgentId ?? "")),
    );
    table.append(el("table", {}, el("thead", {}, head), el("tbody", {}, rows)));
  }
  const discover = el("button", { class: "primary", type: "button" }, t().discover);
  discover.addEventListener("click", async () => {
    discover.disabled = true;
    out.replaceChildren();
    const r = await api("POST", "/devices/discover", {});
    if (!r.ok) {
      const missing = /ENOENT|not found/i.test(String(r.data.error));
      out.append(msg("err", missing ? t().adbMissing : `${t().error}: ${r.data.error}`));
    } else {
      out.append(msg("ok", t().discovered(r.data.added.length, r.data.skipped.length)));
    }
    await load();
    discover.disabled = false;
  });
  const refresh = el("button", { type: "button", class: "ghost", onclick: load }, t().refresh);
  root.append(el("div", { class: "card" }, el("div", { class: "row", style: "margin-top:0" }, discover, refresh), out, table));
  await load();
}

// ---- Providers -------------------------------------------------------------------------------

async function renderProviders(root) {
  const presets = (await api("GET", "/providers/presets")).data;
  const list = el("ul", { class: "plist" });
  const status = el("div");

  async function load() {
    const { data } = await api("GET", "/providers");
    list.replaceChildren();
    if (!Array.isArray(data) || data.length === 0) {
      list.append(el("li", {}, t().noProviders));
      return;
    }
    for (const p of data) {
      const result = el("span");
      const testBtn = el("button", { type: "button" }, t().test);
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        result.replaceChildren(t().testing);
        const r = await api("POST", `/providers/${encodeURIComponent(p.id)}/test`, {});
        result.replaceChildren(r.data.ok ? msg("ok", t().testOk(r.data.model)) : msg("err", t().testFail(r.data.code ?? r.status, r.data.message ?? r.data.error ?? "")));
        testBtn.disabled = false;
      });
      const rm = el("button", { type: "button", class: "ghost" }, t().remove);
      rm.addEventListener("click", async () => {
        await api("DELETE", `/providers/${encodeURIComponent(p.id)}`);
        status.replaceChildren(msg("ok", t().removed));
        await load();
      });
      const chips = [el("span", { class: `chip ${p.keyEnv ? (p.keyPresent ? "ok" : "err") : ""}` }, p.keyEnv ? [el("bdi", {}, p.keyEnv), ` · ${p.keyPresent ? t().keyPresent : t().keyMissing}`] : t().noKey)];
      if (p.isDefault) chips.push(el("span", { class: "chip" }, t().isDefault));
      list.append(el("li", {}, el("div", {}, el("strong", {}, p.id), ` · ${p.kind} · ${p.model}`, p.baseUrl ? ` · ${p.baseUrl}` : "", el("div", {}, chips), result), el("div", { class: "row", style: "margin-top:0" }, testBtn, rm)));
    }
  }

  const sel = el("select", { id: "preset" });
  sel.append(el("option", { value: "anthropic" }, t().anthropic));
  for (const p of presets) sel.append(el("option", { value: p.id }, p.label));
  sel.append(el("option", { value: "custom" }, t().custom));
  const idIn = el("input", { id: "pid", autocomplete: "off" });
  const modelIn = el("input", { id: "pmodel", autocomplete: "off" });
  const urlIn = el("input", { id: "purl", placeholder: "https://…/v1", autocomplete: "off" });
  const envIn = el("input", { id: "penv", placeholder: "GROQ_API_KEY", autocomplete: "off", spellcheck: "false" });
  const urlWrap = el("div", {}, el("label", { for: "purl" }, t().baseUrl), urlIn);
  const envWrap = el("div", {}, el("label", { for: "penv" }, t().envName), envIn, el("div", { class: "help" }, t().envHelp));

  function applyPreset() {
    const v = sel.value;
    const p = presets.find((x) => x.id === v);
    urlWrap.hidden = v !== "custom";
    if (v === "anthropic") {
      idIn.value = "claude";
      modelIn.value = "claude-sonnet-5-5";
      envIn.value = "ANTHROPIC_API_KEY";
      envWrap.hidden = false;
    } else if (p) {
      idIn.value = p.id;
      modelIn.value = p.exampleModel;
      envIn.value = p.defaultEnv;
      envWrap.hidden = !p.requiresKey;
    } else {
      idIn.value = "custom";
      modelIn.value = "";
      envIn.value = "";
      envWrap.hidden = false;
    }
  }
  sel.addEventListener("change", applyPreset);
  applyPreset();

  const add = el("button", { class: "primary", type: "button" }, t().save);
  add.addEventListener("click", async () => {
    const v = sel.value;
    const p = presets.find((x) => x.id === v);
    const auth = envWrap.hidden || !envIn.value.trim() ? { type: "none" } : { type: "api_key", env: envIn.value.trim() };
    const base = { id: idIn.value.trim(), model: modelIn.value.trim(), auth };
    const config = v === "anthropic" ? { ...base, kind: "anthropic" } : p ? { ...base, kind: "openai-compatible", preset: p.id } : { ...base, kind: "openai-compatible", baseUrl: urlIn.value.trim() };
    const r = await api("POST", "/providers", config);
    status.replaceChildren(r.ok ? msg("ok", t().added) : msg("err", `${t().error}: ${r.data.error}`));
    if (r.ok) await load();
  });

  root.append(
    el("div", { class: "card" }, el("h2", {}, t().tabProviders), list),
    el(
      "div",
      { class: "card" },
      el("h2", {}, t().addProvider),
      el("label", { for: "preset" }, t().preset),
      sel,
      el("div", { class: "grid2" }, el("div", {}, el("label", { for: "pid" }, t().providerId), idIn), el("div", {}, el("label", { for: "pmodel" }, t().model), modelIn)),
      urlWrap,
      envWrap,
      el("div", { class: "row" }, add),
      status,
    ),
  );
  await load();
}

// ---- Run a test ------------------------------------------------------------------------------

const events = [];
let source;
let currentTask;
let poller;

function ensureEvents(onEvent) {
  if (source) return;
  source = new EventSource("/events");
  source.onmessage = (e) => {
    try {
      events.push(JSON.parse(e.data));
    } catch {
      return;
    }
    if (events.length > 500) events.shift();
    onEvent();
  };
}

function renderTest(root) {
  const type = el("select", { id: "ttype" }, el("option", { value: "explore" }, t().explore), el("option", { value: "smoke" }, t().smoke));
  const pkg = el("input", { id: "tpkg", placeholder: "com.example.app", autocomplete: "off" });
  const objective = el("textarea", { id: "tobj" }, t().objectiveDefault);
  const apk = el("input", { id: "tapk", placeholder: "/path/to/app.apk", autocomplete: "off" });
  const steps = el("input", { id: "tsteps", type: "number", min: "1", value: "15" });
  const timeout = el("input", { id: "ttimeout", type: "number", min: "10", value: "180" });
  const objWrap = el("div", {}, el("label", { for: "tobj" }, t().objective), objective);
  const apkWrap = el("div", {}, el("label", { for: "tapk" }, t().apkPath), apk);
  const exploreOnly = el("div", { class: "grid2" }, el("div", {}, el("label", { for: "tsteps" }, t().maxSteps), steps), el("div", {}, el("label", { for: "ttimeout" }, t().timeout), timeout));
  const log = el("div", { class: "log" }, t().waiting);
  const resultBox = el("div");
  const status = el("div");

  function sync() {
    const smoke = type.value === "smoke";
    objWrap.hidden = smoke;
    exploreOnly.hidden = smoke;
    apkWrap.hidden = !smoke;
  }
  type.addEventListener("change", sync);
  sync();

  function drawLog() {
    const shown = events.filter((m) => !currentTask || m.task_id === currentTask);
    log.replaceChildren();
    if (shown.length === 0) log.append(t().waiting);
    for (const m of shown) {
      const time = String(m.timestamp ?? "").slice(11, 19);
      const body = m.payload ? JSON.stringify(m.payload) : "";
      log.append(el("div", {}, `${time}  ${m.type}  ${m.from} → ${m.to}  ${body.length > 160 ? `${body.slice(0, 160)}…` : body}`));
    }
    log.scrollTop = log.scrollHeight;
  }
  ensureEvents(() => document.getElementById("view")?.contains(log) && drawLog());
  drawLog();

  function drawResult(rec) {
    resultBox.replaceChildren();
    const r = rec.result;
    resultBox.append(
      el("div", { class: "card" }, el("h2", {}, t().result), el("p", {}, `${t().status}: `, el("strong", {}, rec.status)), r?.summary ? el("p", {}, `${t().summary}: ${r.summary}`) : "", rec.errors?.length ? msg("err", `${t().errors}: ${rec.errors.join("; ")}`) : "", r ? el("pre", { class: "json" }, JSON.stringify(r, (k, v) => (k === "data" && typeof v === "string" && v.length > 200 ? `[${v.length} chars]` : v), 2)) : ""),
    );
  }

  const start = el("button", { class: "primary", type: "button" }, t().start);
  start.addEventListener("click", async () => {
    clearInterval(poller);
    resultBox.replaceChildren();
    status.replaceChildren();
    const smoke = type.value === "smoke";
    const body = smoke
      ? { agentId: "MAIN-01", type: "smoke", payload: { apkPath: apk.value.trim(), packageName: pkg.value.trim() } }
      : { agentId: "MAIN-05", type: "explore", payload: { objective: objective.value.trim(), app: { packageName: pkg.value.trim() }, maxSteps: Number(steps.value), timeoutMs: Number(timeout.value) * 1000 } };
    start.disabled = true;
    const r = await api("POST", "/tests", body);
    start.disabled = false;
    if (!r.ok) {
      status.append(msg("err", `${t().error}: ${r.data.error}`));
      return;
    }
    currentTask = r.data.taskId;
    status.append(msg("ok", t().started(currentTask)));
    drawLog();
    poller = setInterval(async () => {
      const s = await api("GET", `/tests/${encodeURIComponent(currentTask)}`);
      if (!s.ok) return;
      drawResult(s.data);
      if (s.data.status !== "RUNNING" && s.data.status !== "PENDING") clearInterval(poller);
    }, 1500);
  });

  root.append(
    el(
      "div",
      { class: "card" },
      el("label", { for: "ttype" }, t().testType),
      type,
      el("label", { for: "tpkg" }, t().packageName),
      pkg,
      apkWrap,
      objWrap,
      exploreOnly,
      el("div", { class: "msg warn" }, t().privacy),
      el("div", { class: "row" }, start),
      status,
    ),
    el("div", { class: "card" }, el("h2", {}, t().live), log),
    resultBox,
  );
}

// ---- Shell -----------------------------------------------------------------------------------

async function render() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.getElementById("title").textContent = t().title;
  document.title = t().title;
  document.getElementById("lang").textContent = t().lang;
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren();
  for (const [id, label] of [["devices", t().tabDevices], ["providers", t().tabProviders], ["test", t().tabTest]]) {
    tabs.append(el("button", { type: "button", role: "tab", "aria-selected": String(tab === id), onclick: () => ((tab = id), render()) }, label));
  }
  const view = document.getElementById("view");
  view.replaceChildren();
  if (tab === "devices") await renderDevices(view);
  else if (tab === "providers") await renderProviders(view);
  else renderTest(view);
}

document.getElementById("lang").addEventListener("click", () => {
  lang = lang === "ar" ? "en" : "ar";
  try {
    localStorage.setItem("lang", lang);
  } catch {
    /* ignore */
  }
  render();
});
render();
