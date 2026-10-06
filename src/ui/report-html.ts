import type { StoredRun } from "../store/run-store.js";

export type ReportLang = "ar" | "en";

const T = {
  ar: {
    title: "تقرير اختبار AgentLab", status: "الحالة", app: "التطبيق", started: "بدأ", finished: "انتهى", cost: "التكلفة التقديرية", tokens: "الرموز (دخل/خرج)", summary: "الملخص",
    findings: "النتائج", none: "لا نتائج.", verified: "مُتحقَّق منه من السجلات", ai: "ملاحظة النموذج (غير مؤكدة)", repro: "خطوات إعادة الإنتاج", confirmed: "أُعيد حدوثه عند إعادة التشغيل", notRepro: "لم يتكرر عند إعادة التشغيل (قد يكون متقطعاً)", inconclusive: "تعذّر التأكيد",
    steps: "الخطوات", step: "#", action: "الإجراء", reason: "السبب", result: "النتيجة", shots: "لقطات الشاشة", more: "لقطات إضافية غير مضمّنة: ", note: "هذا التقرير مولَّد آلياً. النتائج «المُتحقَّق منها» مصدرها سجلات الجهاز؛ أما ملاحظات النموذج فغير مؤكدة.", unknownCost: "غير محسوبة (لم تُحدَّد الأسعار)",
  },
  en: {
    title: "AgentLab test report", status: "Status", app: "App", started: "Started", finished: "Finished", cost: "Estimated cost", tokens: "Tokens (in/out)", summary: "Summary",
    findings: "Findings", none: "No findings.", verified: "verified from device logs", ai: "model observation (unverified)", repro: "Steps to reproduce", confirmed: "happened again when replayed", notRepro: "did not recur when replayed (may be intermittent)", inconclusive: "could not be confirmed",
    steps: "Steps", step: "#", action: "Action", reason: "Reason", result: "Result", shots: "Screenshots", more: "More screenshots not embedded: ", note: "Generated automatically. “Verified” findings come from device logs; model observations are unconfirmed.", unknownCost: "not computed (no prices given)",
  },
} as const;

const MAX_EMBEDDED = 12;
const esc = (v: unknown): string => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface RFinding { id: string; severity: string; title: string; description: string; source: string; reproSteps?: string[]; reproduced?: string }
interface RAction { step: number; action: string; reason: string; ok: boolean; detail: string }
interface RResult { findings?: RFinding[]; actionLog?: RAction[]; telemetry?: { actions: number; actionFailures: number; llmCalls: number; inputTokens: number; outputTokens: number; durationMs: number; costUsd?: number } }

/** One self-contained page: no script, no external requests, every dynamic value escaped. Screenshots are embedded as data URIs. */
export function renderReportHtml(run: StoredRun, shots: ReadonlyMap<string, Buffer>, lang: ReportLang, nonce: string): string {
  const t = T[lang];
  const result = (run.result ?? {}) as RResult;
  const findings = result.findings ?? [];
  const actions = result.actionLog ?? [];
  const tel = result.telemetry;
  const cost = run.costUsd ?? tel?.costUsd;
  const embedded = [...shots].slice(0, MAX_EMBEDDED);
  const reproLabel = (r?: string) => (r === "CONFIRMED" ? t.confirmed : r === "NOT_REPRODUCED" ? t.notRepro : r === "INCONCLUSIVE" ? t.inconclusive : "");

  const findingHtml = findings.length
    ? findings
        .map(
          (f) => `<div class="f"><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span> <b>${esc(f.title)}</b>
<small>— ${f.source === "VERIFIED" ? t.verified : t.ai}</small>
<p>${esc(f.description)}</p>
${f.reproSteps?.length ? `<div class="rs"><b>${t.repro}</b><ol>${f.reproSteps.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ""))}</li>`).join("")}</ol>${f.reproduced ? `<p class="rp ${esc(f.reproduced)}">${reproLabel(f.reproduced)}</p>` : ""}</div>` : ""}</div>`,
        )
        .join("")
    : `<p>${t.none}</p>`;

  const stepsHtml = actions.length
    ? `<table><thead><tr><th>${t.step}</th><th>${t.action}</th><th>${t.reason}</th><th>${t.result}</th></tr></thead><tbody>${actions
        .map((a) => `<tr><td>${esc(a.step)}</td><td dir="ltr">${esc(a.action)}</td><td>${esc(a.reason)}</td><td class="${a.ok ? "ok" : "bad"}">${esc(a.detail)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";

  const shotsHtml = embedded.length
    ? `<h2>${t.shots}</h2><div class="shots">${embedded.map(([id, png]) => `<figure><img alt="${esc(id)}" src="data:image/png;base64,${png.toString("base64")}"><figcaption dir="ltr">${esc(id)}</figcaption></figure>`).join("")}</div>${shots.size > MAX_EMBEDDED ? `<p class="n">${t.more}${shots.size - MAX_EMBEDDED}</p>` : ""}`
    : "";

  return `<!doctype html>
<html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)} — ${esc(run.packageName)}</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#1b1f24;--mut:#5d6672;--line:#dde1e6;--card:#f5f6f8;--ok:#15803d;--bad:#b91c1c;--warn:#b45309}
@media(prefers-color-scheme:dark){:root{--bg:#0f1318;--fg:#e6e9ee;--mut:#9aa4b2;--line:#2b333c;--card:#171c22;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}main{max-width:960px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px}h2{margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px}.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:12px 0}.kv div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.kv small{display:block;color:var(--mut)}
.pill{display:inline-block;padding:2px 12px;border-radius:99px;background:var(--card);border:1px solid var(--line);font-weight:700}.pill.PASSED,.pill.MAX_STEPS_REACHED{color:var(--ok)}.pill.FAILED,.pill.ERROR{color:var(--bad)}
.f{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0}.sev{font-size:12px;font-weight:700;padding:1px 8px;border-radius:99px;background:var(--card);border:1px solid var(--line)}.sev.CRITICAL,.sev.HIGH{color:var(--bad)}.sev.MEDIUM{color:var(--warn)}
.rs{background:var(--card);border-radius:6px;padding:6px 12px}.rp{font-weight:600;margin:4px 0}.rp.CONFIRMED{color:var(--bad)}.rp.NOT_REPRODUCED,.rp.INCONCLUSIVE{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:5px 8px;text-align:start;vertical-align:top}td.ok{color:var(--ok)}td.bad{color:var(--bad)}
.shots{display:flex;flex-wrap:wrap;gap:10px}figure{margin:0}img{height:260px;border:1px solid var(--line);border-radius:8px}figcaption{color:var(--mut);font-size:12px}.n,.foot{color:var(--mut);font-size:13px}
@media print{img{height:200px}}
</style></head><body><main>
<h1>${t.title}</h1>
<p><span class="pill ${esc(run.status)}">${esc(run.status)}</span> <span dir="ltr">${esc(run.packageName)}</span></p>
<div class="kv"><div><small>${t.app}</small><span dir="ltr">${esc(run.packageName)}</span></div><div><small>${t.started}</small><span dir="ltr">${esc(run.startedAt)}</span></div><div><small>${t.finished}</small><span dir="ltr">${esc(run.finishedAt ?? "")}</span></div>
<div><small>${t.cost}</small>${cost === undefined ? t.unknownCost : `$${esc(cost.toFixed(4))}`}</div><div><small>${t.tokens}</small><span dir="ltr">${esc(run.inputTokens)} / ${esc(run.outputTokens)}</span></div></div>
<h2>${t.summary}</h2><p>${esc(run.summary)}</p>
<h2>${t.findings}</h2>${findingHtml}
${actions.length ? `<h2>${t.steps}</h2>${stepsHtml}` : ""}
${shotsHtml}
<p class="foot">${t.note}</p>
</main></body></html>`;
}
