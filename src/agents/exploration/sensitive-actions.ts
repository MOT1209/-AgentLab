import type { Point } from "./actions.js";
import type { UiElement } from "./observation.js";

/**
 * Deterministic guard (never the model) against destructive or paid taps.
 *
 * The exploration agent must not spend money or wipe data on the app under test
 * just because a screen offered the button. This is a plain pattern check over
 * the element's own text/description/resource-id, covering English, Arabic and
 * German for: buy/purchase/pay, subscribe, delete account, factory reset and
 * uninstall. It errs toward refusing; a caller that really wants these taps sets
 * `allowSensitiveActions: true` on the task payload.
 */
export interface SensitiveTerm {
  readonly category: string;
  readonly re: RegExp;
}

/**
 * Arabic (no `\b`: `\w` is ASCII-only, so a word boundary never fires around Arabic script).
 * `\b` is replaced by a lookahead that refuses a match immediately followed by another Arabic
 * letter, which is what stops one word from being a substring hit of a shorter one:
 * `اشتر` ("buy") is a prefix of `اشترك` ("subscribe") and of `الاشتراك` ("the subscription"),
 * so without this every subscribe button would be reported as a purchase.
 */
const AR = "(?![\\u0600-\\u06FF])";
export const SENSITIVE_TERMS: readonly SensitiveTerm[] = [
  // English (word-boundaried; ids like .../buy_button are normalized to spaces first)
  { category: "purchase", re: /\b(buy|purchase|checkout|order now|place order)\b/i },
  { category: "payment", re: /\b(pay|pay now|payment|add card|credit card)\b/i },
  { category: "subscribe", re: /\b(subscribe|subscription|upgrade plan|start trial)\b/i },
  { category: "delete-account", re: /\b(delete|remove|close)\s+account\b|\bdelete my account\b/i },
  { category: "factory-reset", re: /\bfactory reset\b|\berase all data\b|\breset device\b/i },
  { category: "uninstall", re: /\buninstall\b/i },
  // German
  { category: "purchase", re: /\b(kaufen|jetzt kaufen|kostenpflichtig bestellen)\b/i },
  { category: "payment", re: /\b(bezahlen|zahlung|zahlungspflichtig|kreditkarte)\b/i },
  { category: "subscribe", re: /\b(abonnieren|abo abschlie)\b|\babo\b/i },
  { category: "delete-account", re: /konto\s+(löschen|entfernen)|account löschen/i },
  { category: "factory-reset", re: /werkseinstellungen|auf werkszustand/i },
  { category: "uninstall", re: /deinstallieren/i },
  // Arabic
  { category: "purchase", re: new RegExp(`(?:شراء${AR}|اشتر${AR}|شراء الآن${AR}|اتمام الشراء${AR})`) },
  { category: "payment", re: new RegExp(`(?:ادفع${AR}|الدفع${AR}|دفع الآن${AR}|بطاقة ائتمان${AR})`) },
  { category: "subscribe", re: new RegExp(`(?:اشترك${AR}|اشتراك${AR}|ترقية${AR}|ابدأ التجربة${AR})`) },
  { category: "delete-account", re: new RegExp(`(?:حذف\\s+(?:الحساب|حسابي)${AR}|إغلاق\\s+الحساب${AR}|الغاء\\s+الحساب${AR})`) },
  { category: "factory-reset", re: new RegExp(`(?:إعادة\\s+ضبط\\s+المصنع${AR}|اعادة\\s+ضبط\\s+المصنع${AR}|ضبط\\s+المصنع${AR}|مسح\\s+جميع\\s+البيانات${AR})`) },
  { category: "uninstall", re: new RegExp(`(?:إلغاء\\s+التثبيت${AR}|الغاء\\s+التثبيت${AR}|إزالة\\s+التطبيق${AR})`) },
];

/**
 * Resource ids and class names glue words with `_ . / : -` and with camelCase humps.
 * Both are split into spaces, because `\b` is defined over `\w` ([A-Za-z0-9_]) and so never
 * fires inside `buyButton` or after the `y` in `btnBuyNow` - which is exactly how Android
 * ids are usually written. Without the camelCase rule the patterns below silently miss them.
 */
function normalize(raw: string): string {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:\-]+/g, " ");
}

/** The category of the first sensitive term found in the text, or undefined. Pure and total. */
export function sensitiveTerm(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = normalize(text);
  for (const term of SENSITIVE_TERMS) if (term.re.test(t)) return term.category;
  return undefined;
}

const MATCH_TOLERANCE_PX = 2;

/**
 * If a TAP target lands on a UI element whose label/description/id reads as a
 * sensitive action, returns that element and the matched category. The model is
 * told to tap element centers, so matching is on the center within a couple of
 * pixels (rounding slack). Elements carry no bounds here, so a tap at free
 * coordinates that happens to sit over a sensitive control cannot be caught —
 * that is a known limitation, documented in known-issues.md.
 */
export function sensitiveTapTarget(
  ui: readonly UiElement[] | undefined,
  target: Point,
): { category: string; label: string } | undefined {
  if (!ui) return undefined;
  for (const e of ui) {
    if (Math.abs(e.x - target.x) > MATCH_TOLERANCE_PX || Math.abs(e.y - target.y) > MATCH_TOLERANCE_PX) continue;
    const category = sensitiveTerm(e.text) ?? sensitiveTerm(e.desc) ?? sensitiveTerm(e.id);
    if (category) return { category, label: e.text ?? e.desc ?? e.id ?? `${e.x},${e.y}` };
  }
  return undefined;
}
