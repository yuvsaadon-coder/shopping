# קניות בבית – הקשר לסשן חדש של Claude Code

- עונים בעברית, מיושר לימין. מה שאפשר לפתור בקוד – פותרים לבד; שואלים רק על הרשאות, חיובים ויציבות.
- אין מפתחות API בקוד (המאגר ציבורי). `ANTHROPIC_API_KEY` נשמר רק כסוד ב-Cloudflare (`worker/sync-secrets.sh` מעתיק אותו מ-Build secrets).
- אחרי כל שינוי: `npm test` (בענן: `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm test`), commit, push, ובדיקה שה-CI עבר.
- בכל שחרור: להעלות את `CACHE` ב-`sw.js`.
- אבטחה לא נדרשת (בקשת המשתמש): רשימה אחת לכל מי שפותח את הכתובת, CORS פתוח.

## האפליקציה
- `products.js`: רשימת הפתיחה (44 מוצרים שהופיעו בלפחות 3 ימים שונים בקבוצת הווטסאפ; כתיבים שונים אוחדו), קטגוריות וניחוש אימוג'י למוצר חדש.
- `app.js`: מסכים – מה חסר, הרשימה, איפה זול, הגדרות. מצב ב-`localStorage` (`shop-state-v2`), סנכרון כל 10 שניות ובכל שינוי (`/list`, מיזוג לפי `at` לכל מוצר, בחירת מוצר ודמי משלוח).
- **השוואת מחירים רק בלחיצה** (`runCompare`): `/prices?fresh=1` לכל מוצר → `/advice` → נשמר ב-`S.compare` ונשלח ל-`/compare`, כך שגם המכשירים האחרים רואים אותו. בחירת מוצר בכל רשת: ידנית (`prefs`) → Claude (`advice.picks`) → התאמת מילים. "סל משותף" = מוצרים שנמצאו בכל הרשתות; ההמלצה בלי Claude = הזול בסל המשותף + משלוח.
- אריח המוצר: אימוג'י על רקע בצבע הקטגוריה; תמונה מאתר הרשת מחליפה אותו אחרי חיפוש.

## השרת (`worker/worker.js`, Cloudflare Worker `shopping`)
- `/list`, `/compare` – ב-KV `LIBRARY` (משותף עם "מה שנקרא"; מפתחות `shoplist:*`).
- `/prices` – מפענחים לכל רשת (`parseShufersal`, `parseRami`, `parseHtmlProducts`), `parseSize`/`unitPrice` למחיר ליחידה, `promoText` למבצעים. מטמון 30 דקות, `fresh=1` עוקף.
- `/advice` – Claude (`claude-opus-5-5`, structured output, `fallbacks: "default"`), עד 40 ביום. בחירה שלא מצביעה על מוצר אמיתי נזרקת.
- כתובות ה-API של הרשתות לא נבדקו מול האתרים האמיתיים (חסומים בסביבת הענן).
