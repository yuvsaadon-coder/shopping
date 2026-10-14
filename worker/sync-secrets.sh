#!/bin/sh
# רץ בזמן הבנייה ב-Cloudflare (Workers Builds). סודות שהוגדרו כ-Build secrets זמינים רק בזמן הבנייה,
# לכן מעבירים אותם כאן לסודות של השרת עצמו. הערך לא מודפס ללוג. אם לא הוגדר – מדלגים.
if [ -n "$ANTHROPIC_API_KEY" ]; then
  printf '%s' "$ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY --name shopping123 >/dev/null 2>&1 \
    && echo "ANTHROPIC_API_KEY copied to the worker's runtime secrets" \
    || echo "Could not copy ANTHROPIC_API_KEY (continuing)"
else
  echo "No ANTHROPIC_API_KEY build variable; skipping"
fi
exit 0
