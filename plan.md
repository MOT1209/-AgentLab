# خطة تطوير AgentLab / Entwicklungsplan AgentLab

## العربية

### السياق
AgentLab أداة لاختبار تطبيقات أندرويد بوكلاء ذكاء اصطناعي (TypeScript، Node 22، نحو 7.4 ألف سطر، نحو 207 اختبار كلها بلا اتصال). المراجعة الكاملة أظهرت أن **البنية أكبر بكثير مما تم إثباته**:
- وكيلان فقط من 36 لهما سلوك فعلي (MAIN-01-B للـ smoke، وMAIN-05-A للاستكشاف). الباقي يرجع BLOCKED.
- لم يُشغَّل أي شيء على جهاز حقيقي أو نموذج حي.
- أقيم جزء هو وحدة الاستكشاف (نحو 1.4 ألف سطر). بقية الهرمية (حالات الـ pool والـ skill profiles والتحقق من 36 وكيلاً) تلفّ معالجين فقط.

**الهدف المعتمد:** أداة شخصية/داخلية خلال 3 أشهر (لا حسابات ولا دفع ولا استضافة). **المتاح:** جهاز أو محاكٍ تشغّل عليه الأوامر وترسل النتائج، لذلك تبدأ المرحلة 0 أولاً.

### أهم النتائج (مع المواضع)
- **فجوة الإثبات:** `uiautomator dump` إلى `/dev/tty` قد يفشل بصمت ويعيد واجهة فارغة (`src/device/adb-device.ts:119`). كشف الأعطال يقرأ آخر 100 سطر logcat فقط (`:123`)، والأفضل `logcat -b crash`. `STOP_APP` لا يمسح السجلات، فقد تظهر نتيجة "process died" كاذبة.
- **الأمان:**
  - H1: الـ prompt يذكر `untrustedDeviceData` لكنه لا يُرسَل أبداً (`src/agents/exploration/prompt.ts:22,44-58`).
  - H2: `observe()` يقرأ اللقطة والواجهة والسجلات دون فحص صلاحيات (`exploration-agent.ts:221-243`).
  - H3: `SkillResolver` استشاري فقط.
  - H4: سقف التكلفة والرموز يفشل مفتوحاً إذا لم يرجع المزوّد `usage` (`openai-compatible-provider.ts:68`).
  - إعادة تشغيل الأعطال وأداة `tap` في MCP تتجاوزان حارس اللمسات الحساسة. الإخفاء (redaction) ناقص ويُقصّ قبل الإخفاء. عناوين `http://` مسموحة لمزوّد بمفتاح.
- **بيئة التشغيل:** لا مهلة لكل مهمة (smoke قد يعلق للأبد). لا انتهاء لعقود BUSY. ربط MAIN بجهاز ثابت (جهاز واحد يعني 11 وكيلاً BLOCKED). لا طابور. الأخطاء تُختزل إلى رسالة. الواجهة وMCP لكل منهما DeviceManager منفصل.
- **الواجهة/التخزين/CI:** الرمز طويل العمر ويظهر في الروابط. تشغيل واحد فقط وpolling كل ثانية. `node:sqlite` تجريبي بلا إصدار مخطط. لا lint ولا audit في CI. توثيق قديم.

### المراحل (كل مرحلة تنتهي بنجاح `npm test` و`npm run skills:validate`، والاختبار يُكتب قبل الإصلاح)
**المرحلة 0 – إثبات المسار الحقيقي (تُنفَّذ على جهازك):** تشغيل `npm run explore -- --package <app>` والـ smoke على محاكٍ، وإصلاح ما ينكسر: بديل لـ uiautomator dump عبر ملف على `/sdcard` وكشف غياب `<node>` كخطأ، و`logcat -b crash`، والتحقق من مخرجات launch، وتقديس الرمز `$`. الناتج: تشغيل حقيقي مسجّل واختبار جهاز حقيقي. معيار الإنهاء: إغلاق أو إعادة تصنيف بنود HIGH العشرة في `known-issues.md`.

**المرحلة 1 – سد الثغرات الأمنية (بلا جهاز):**
1. إرسال `untrustedDeviceData` فعلياً في `buildUserMessage` مع اختبار.
2. ربط `observe()` بصلاحيات الـ profile.
3. الفشل المغلق عند غياب `usage` (فرض `maxLlmCalls` وتقدير الرموز، وسقف مال افتراضي أو "بلا سقف" صريح).
4. تمرير إعادة التشغيل وأداة MCP `tap` عبر `sensitive-actions.ts`.
5. إخفاء قبل القص، وأنماط أكثر (AKIA وAIza وgithub_pat_ وPEM وpassword=)، وإخفاء ids/errors/evidence/مخرجات MCP، وفحص Luhn للبطاقات.
6. رفض `http://` لمزوّد بمفتاح إلا loopback، وحماية `res.json()`.
7. إما ربط SkillResolver فعلياً أو حذف الادعاء من التوثيق.

**المرحلة 2 – موثوقية التشغيل:** مهلة وإلغاء (AbortSignal) في smoke وdelegate. انتهاء/نبض لعقود BUSY. حفظ stack ورمز الخطأ. تخصيص ديناميكي للأجهزة بالمتاح أصلاً (`lockAny`/`findAvailable`). طابور بدل BLOCKED. DeviceManager مشترك أو توثيق قاعدة العملية الواحدة. معالجة طلبات MCP بالتوازي.

**المرحلة 3 – تبسيط:** حذف الكود الميت (`DeviceManager.deviceFor` وطرق registry غير المستخدمة و`savedScreenshot`). دالة موحدة لنتائج BLOCKED (نحو 12 نسخة). التحقق من التعريفات مرة واحدة. تقسيم `ui/app.ts` و`ui/page.ts`. **بوابة قرار:** إن كان لدى أقل من نحو 6 وكلاء سلوك بعد المرحلة 4، تُختزل الهرمية إلى سجل قدرات مسطّح.

**المرحلة 4 – قيمة المنتج (اختيارية حسب نتائج المرحلة 0):** مقارنة لقطات عبر أحجام شاشات (فكرة فقط من Responsively، بلا نسخ كود لأن رخصته AGPL). تسجيلات قابلة لإعادة التشغيل. وكلاء جدد: Edge Case وRegression وفحص إتاحة عبر الهرمية. تقييم الرؤية على لعبة/WebView. MCP يبقى صغيراً.

**المرحلة 5 – نظافة وCI:** eslint/prettier، `npm audit`، مصفوفة إصدارات Node مع تثبيت بسبب `node:sqlite`، كتلة `permissions:`، اختبار واجهة بمتصفح headless. التخزين: إصدار مخطط وWAL وbusy_timeout وإنشاء الملف بصلاحية 0600 قبل الاستخدام. الواجهة: رمز قصير العمر بلا رمز في الروابط، وSSE بدل polling كامل، وإلغاء اشتراكات الـ bus. التوثيق: تحديث README وملفات project-memory وتوضيح `AgentLab-Report.html`.

### التحقق
اختبار فاشل أولاً ثم `npm test` (نحو 200 اختبار بلا اتصال) و`npm run skills:validate`. المرحلة 0: تشغيل على محاكٍ حقيقي و`npm run test:real`. المرحلة 5: CI أخضر على ubuntu وwindows.

### المخاطر
قد تكشف المرحلة 0 مشاكل أعمق (uiautomator على أجهزة بعض الشركات) وتغيّر الترتيب، لذلك تُنفَّذ أولاً ثم تُعاد الخطة. حذف الهرمية (المرحلة 3) آمن فقط بعد بوابة القرار. ممنوع نسخ كود Responsively (AGPL ضد MIT).

---

## Deutsch

### Kontext
AgentLab ist ein Werkzeug zum Testen von Android-Apps mit KI-Agenten (TypeScript, Node 22, rund 7.400 Zeilen, rund 207 Tests, alle ohne Netzwerk). Die vollständige Prüfung zeigt: **Die Architektur ist viel größer als das, was nachgewiesen ist.**
- Nur 2 von 36 Agenten haben echtes Verhalten (MAIN-01-B Smoke, MAIN-05-A Erkundung). Der Rest liefert BLOCKED.
- Nichts lief je auf einem echten Gerät oder mit einem echten Modell.
- Wertvoll ist vor allem das Erkundungsmodul (rund 1.400 Zeilen). Der Rest der Hierarchie (Pool-Zustände, Skill-Profile, Validierung von 36 Agenten) umhüllt nur zwei Handler.

**Beschlossenes Ziel:** persönliches/internes Werkzeug in 3 Monaten (keine Konten, keine Zahlung, kein Hosting). **Verfügbar:** ein Gerät oder Emulator, auf dem du Befehle ausführst und Ergebnisse zurückschickst; daher beginnt Phase 0 zuerst.

### Wichtigste Befunde (mit Fundstellen)
- **Nachweislücke:** `uiautomator dump` nach `/dev/tty` kann stumm scheitern und eine leere UI liefern (`src/device/adb-device.ts:119`). Die Absturzerkennung liest nur die letzten 100 logcat-Zeilen (`:123`); besser ist `logcat -b crash`. `STOP_APP` leert die Logs nicht, daher drohen falsche „process died"-Funde.
- **Sicherheit:**
  - H1: Der Prompt nennt `untrustedDeviceData`, es wird aber nie gesendet (`src/agents/exploration/prompt.ts:22,44-58`).
  - H2: `observe()` liest Screenshot, UI und Logs ohne Rechteprüfung (`exploration-agent.ts:221-243`).
  - H3: `SkillResolver` ist nur beratend.
  - H4: Kosten- und Token-Limit versagen offen, wenn der Anbieter `usage` weglässt (`openai-compatible-provider.ts:68`).
  - Crash-Replay und das MCP-Tool `tap` umgehen den Schutz vor sensiblen Taps. Schwärzung ist lückenhaft und kürzt vor dem Schwärzen. `http://` ist für Anbieter mit Schlüssel erlaubt.
- **Laufzeit:** kein Timeout pro Aufgabe (Smoke kann ewig hängen), BUSY-Leases laufen nie ab, feste MAIN-Gerät-Zuordnung (1 Gerät heißt 11 Agenten BLOCKED), keine Warteschlange, Fehler auf eine Nachricht reduziert, UI und MCP haben je einen eigenen DeviceManager.
- **UI/Speicher/CI:** langlebiges Token, das in URLs auftaucht; nur ein Lauf und Polling jede Sekunde; `node:sqlite` experimentell ohne Schemaversion; kein Lint/Audit in CI; veraltete Doku.

### Phasen (jede endet mit grünem `npm test` und `npm run skills:validate`; Test zuerst)
**Phase 0 – Echten Pfad nachweisen (auf deinem Gerät):** `npm run explore -- --package <app>` und Smoke auf einem Emulator ausführen und beheben, was bricht: Ersatz für uiautomator dump über eine Datei auf `/sdcard` und fehlendes `<node>` als Fehler melden, `logcat -b crash`, Ausgabe von launch prüfen, `$` quoten. Ergebnis: ein aufgezeichneter echter Lauf und ein Echtgerät-Test. Abschlusskriterium: die zehn HIGH-Punkte in `known-issues.md` sind geschlossen oder neu eingestuft.

**Phase 1 – Sicherheitslücken schließen (ohne Gerät):**
1. `untrustedDeviceData` in `buildUserMessage` tatsächlich senden, mit Test.
2. `observe()` an die Profilrechte binden.
3. Geschlossen scheitern ohne `usage` (`maxLlmCalls` erzwingen, Tokens schätzen, Standard-Geldlimit oder ausdrückliches „kein Limit").
4. Replay und MCP-`tap` durch `sensitive-actions.ts` leiten.
5. Erst schwärzen, dann kürzen; mehr Muster (AKIA, AIza, github_pat_, PEM, password=); IDs/Fehler/Evidence/MCP-Ausgaben schwärzen; Luhn-Prüfung für Karten.
6. `http://` bei Anbietern mit Schlüssel nur für Loopback; `res.json()` absichern.
7. Entweder SkillResolver wirklich anbinden oder den Anspruch aus der Doku streichen.

**Phase 2 – Laufzeit-Zuverlässigkeit:** Timeout und Abbruch (AbortSignal) in Smoke und delegate. Ablauf/Heartbeat für BUSY-Leases. Stack und Fehlercode erhalten. Dynamische Gerätezuweisung mit dem vorhandenen `lockAny`/`findAvailable`. Warteschlange statt BLOCKED. Gemeinsamer DeviceManager oder dokumentierte Ein-Prozess-Regel. MCP-Anfragen parallel verarbeiten.

**Phase 3 – Vereinfachen:** Toten Code löschen (`DeviceManager.deviceFor`, ungenutzte Registry-Methoden, `savedScreenshot`). Gemeinsamer Helfer für BLOCKED-Ergebnisse (rund 12 Kopien). Definitionen nur einmal validieren. `ui/app.ts` und `ui/page.ts` aufteilen. **Entscheidungstor:** Haben nach Phase 4 weniger als rund 6 Agenten Verhalten, wird die Hierarchie zu einem flachen Fähigkeiten-Register zusammengelegt.

**Phase 4 – Produktwert (optional, je nach Ergebnis von Phase 0):** Screenshot-Vergleich über Bildschirmgrößen (nur die Idee von Responsively, kein Code wegen AGPL). Wiederabspielbare Aufzeichnungen. Neue Agenten: Edge Case, Regression, Barrierefreiheit über die UI-Hierarchie. Vision-Modus an einem Spiel/WebView bewerten. MCP bleibt klein.

**Phase 5 – Hygiene und CI:** eslint/prettier, `npm audit`, Node-Versionsmatrix mit Festlegung wegen `node:sqlite`, `permissions:`-Block, Browser-Smoketest der UI (headless). Speicher: Schemaversion, WAL, busy_timeout, Datei mit 0600 vor der Nutzung anlegen. UI: kurzlebiges Token ohne Token in URLs, SSE statt vollem Polling, Bus-Abos pro Lauf abmelden. Doku: README und project-memory aktualisieren, `AgentLab-Report.html` klären.

### Prüfung
Zuerst fehlschlagender Test, dann `npm test` (rund 200 Tests ohne Netzwerk) und `npm run skills:validate`. Phase 0: Lauf auf echtem Emulator und `npm run test:real`. Phase 5: CI grün auf ubuntu und windows.

### Risiken
Phase 0 kann tiefere Probleme aufdecken (uiautomator auf Geräten einzelner Hersteller) und die Reihenfolge ändern; sie läuft deshalb zuerst, danach wird neu geplant. Das Entfernen der Hierarchie (Phase 3) ist erst nach dem Entscheidungstor sicher. Kein Responsively-Code darf kopiert werden (AGPL gegen MIT).
