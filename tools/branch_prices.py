#!/usr/bin/env python3
"""מחירים ומבצעים לפי סניף, מקבצי שקיפות המחירים שכל רשת מפרסמת לפי חוק (חוק המזון, 2015).

רץ ב-GitHub Actions (יומי), בלי ספריות חיצוניות. לכל סניף ב-BRANCHES:
  1. מוצא את מספר הסניף בקובץ החנויות של הרשת (לפי מילים בשם/בכתובת).
  2. מוריד את קבצי PriceFull + PromoFull האחרונים של הסניף.
  3. כותב data/branches/<id>.json:  {"items": [[שם, מחיר, יחידה, מחיר ליחידה, מבצע], ...]}
ובסוף data/branches/index.json עם רשימת הסניפים שנמצאו ושעת העדכון.

מקורות: שופרסל – prices.shufersal.co.il ; רמי לוי ואושר עד – שרת ה-FTP url.retail.publishedprices.co.il (משתמש בלי סיסמה).
"""
import datetime as dt
import ftplib
import gzip
import io
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'branches')
UA = {'User-Agent': 'Mozilla/5.0 (kniyot-babayit price data)'}

# id, רשת, שם לתצוגה, מילים שצריכות להופיע בשם/בכתובת הסניף (כולן), מילים שלא
BRANCHES = [
    ('rami-givat-shaul', 'rami', 'רמי לוי גבעת שאול', ['גבעת שאול'], []),
    ('rami-talpiot', 'rami', 'רמי לוי תלפיות', ['תלפיות'], ['מזרח']),
    ('shufersal-talpiot', 'shufersal', 'שופרסל תלפיות', ['תלפיות'], ['מזרח']),
    ('shufersal-nayot', 'shufersal', 'שופרסל ניות', ['ניות'], []),
    ('osherad-talpiot', 'osherad', 'אושר עד תלפיות', ['תלפיות'], ['מזרח']),
    ('osherad-givat-shaul', 'osherad', 'אושר עד גבעת שאול', ['גבעת שאול'], []),
]
CERBERUS = {'rami': 'RamiLevi', 'osherad': 'osherad'}
CHAIN_NAME = {'rami': 'רמי לוי', 'shufersal': 'שופרסל', 'osherad': 'אושר עד'}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def unpack(data):
    """קבצים מגיעים כ-gz, zip או XML רגיל"""
    if data[:2] == b'\x1f\x8b':
        return gzip.decompress(data)
    if data[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return z.read(z.namelist()[0])
    return data


def parse_xml(data):
    data = unpack(data)
    if data[:2] in (b'\xff\xfe', b'\xfe\xff'):   # UTF-16 (יש רשתות שמפרסמות כך)
        data = data.decode('utf-16').encode('utf-8').replace(b'encoding="utf-16"', b'encoding="utf-8"').replace(b'encoding="UTF-16"', b'encoding="utf-8"')
    return ET.fromstring(data)


def low(tag):
    return tag.split('}')[-1].lower()


def records(root, must):
    """כל אלמנט שיש לו את כל השדות ב-must (בלי תלות באותיות גדולות/קטנות) → dict"""
    out = []
    for el in root.iter():
        kids = {low(c.tag): (c.text or '').strip() for c in el if len(c) == 0}
        if all(k in kids for k in must):
            kids['_el'] = el
            out.append(kids)
    return out


# ---------- קובץ החנויות → מספר סניף ----------
def match_store(stores, words, exclude):
    found = []
    for s in stores:
        text = ' '.join(s.get(k, '') for k in ('storename', 'address', 'city'))
        if all(w in text for w in words) and not any(x in text for x in exclude):
            found.append(s)
    # מעדיפים סניף בירושלים כשיש כמה
    found.sort(key=lambda s: 0 if 'ירושלים' in s.get('city', '') + s.get('address', '') + s.get('storename', '') else 1)
    return found


# ---------- מחירים ומבצעים ----------
def num(x):
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return 0


def parse_prices(root):
    items = {}
    for r in records(root, ['itemcode', 'itemprice']):
        name = r.get('itemname') or r.get('manufactureritemdescription') or ''
        price = num(r.get('itemprice'))
        if not name or not price:
            continue
        qty, unit = r.get('quantity', ''), r.get('unitqty', '')
        size = f"{num(qty):g} {unit}".strip() if num(qty) else unit
        per = ''
        if num(r.get('unitofmeasureprice')) and r.get('unitofmeasure'):
            per = f"{num(r.get('unitofmeasureprice')):g} ל{r.get('unitofmeasure')}"
        items[r['itemcode']] = [re.sub(r'\s+', ' ', name)[:70], price, size[:20], per[:24], '']
    return items


def parse_promos(root, items, today):
    for p in records(root, ['promotiondescription']):
        end = p.get('promotionenddate', '')[:10]
        if end and end < today:
            continue
        desc = re.sub(r'\s+', ' ', p.get('promotiondescription', ''))[:40]
        codes = [low_el.text.strip() for low_el in p['_el'].iter() if low(low_el.tag) == 'itemcode' and low_el.text]
        for c in codes:
            if c in items and not items[c][4]:
                items[c][4] = desc


# ---------- שופרסל ----------
def shufersal_links(cat, store=None):
    url = f'https://prices.shufersal.co.il/FileObject/UpdateCategory?catID={cat}' + (f'&storeId={store}' if store else '')
    html = get(url).decode('utf-8', 'replace')
    return re.findall(r'href="(https://[^"]+?\.(?:gz|xml|zip)[^"]*)"', html.replace('&amp;', '&'))


def shufersal_stores():
    links = shufersal_links(5)
    if not links:
        raise RuntimeError('no Shufersal stores file')
    return records(parse_xml(get(links[0])), ['storeid', 'storename'])


def shufersal_file(kind, store):
    links = shufersal_links({'PriceFull': 2, 'PromoFull': 4}[kind], store)
    links = [l for l in links if kind.lower() in l.lower()] or links
    if not links:
        raise RuntimeError(f'no Shufersal {kind} for store {store}')
    return parse_xml(get(links[0]))


# ---------- Cerberus (רמי לוי, אושר עד) ----------
class Cerberus:
    def __init__(self, user):
        self.ftp = ftplib.FTP_TLS('url.retail.publishedprices.co.il', timeout=120)
        self.ftp.trust_server_pasv_ipv4_address = True
        self.ftp.login(user, '')
        self.names = self.ftp.nlst()
        log(f'{user}: {len(self.names)} files')

    def fetch(self, name):
        buf = io.BytesIO()
        self.ftp.retrbinary('RETR ' + name, buf.write)
        return buf.getvalue()

    def latest(self, prefix, store=None):
        pat = re.compile(rf'^{prefix}\d{{13}}-(?:\d{{3}}-)?(\d{{3,4}})-(\d{{8,12}})', re.I) if store else re.compile(rf'^{prefix}\d{{13}}-(\d{{8,12}})', re.I)
        best = None
        for n in self.names:
            m = pat.match(n)
            if not m:
                continue
            if store and int(m.group(1)) != int(store):
                continue
            stamp = m.group(2) if store else m.group(1)
            if not best or stamp > best[0]:
                best = (stamp, n)
        return best and best[1]

    def stores(self):
        n = self.latest('Stores')
        if not n:
            raise RuntimeError('no stores file')
        return records(parse_xml(self.fetch(n)), ['storeid', 'storename'])

    def file(self, kind, store):
        n = self.latest(kind, store)
        if not n:
            raise RuntimeError(f'no {kind} for store {store}')
        return parse_xml(self.fetch(n))


def main(only=None):
    os.makedirs(OUT, exist_ok=True)
    today = dt.date.today().isoformat()
    index = {'updated': dt.datetime.now(dt.timezone.utc).isoformat(timespec='minutes'), 'branches': []}
    sources = {}
    for bid, chain, label, words, exclude in BRANCHES:
        if only and chain not in only:
            continue
        try:
            if chain not in sources:
                sources[chain] = Cerberus(CERBERUS[chain]) if chain in CERBERUS else 'shufersal'
            src = sources[chain]
            stores = src.stores() if chain in CERBERUS else shufersal_stores()
            found = match_store(stores, words, exclude)
            if not found:
                log(f'{label}: store not found among {len(stores)}; examples: ' + ', '.join(s.get("storename", "") for s in stores[:15]))
                continue
            st = found[0]
            sid = st['storeid']
            log(f'{label}: store {sid} {st.get("storename")} | {st.get("address")} {st.get("city")}')
            fetch = (lambda k: src.file(k, sid)) if chain in CERBERUS else (lambda k: shufersal_file(k, sid))
            items = parse_prices(fetch('PriceFull'))
            try:
                parse_promos(fetch('PromoFull'), items, today)
            except Exception as e:   # בלי מבצעים עדיף על בלי כלום
                log(f'{label}: promos failed: {e}')
            rows = sorted(items.values(), key=lambda r: r[0])
            with open(os.path.join(OUT, bid + '.json'), 'w', encoding='utf-8') as f:
                json.dump({'id': bid, 'name': label, 'chain': chain, 'store': sid, 'storeName': st.get('storename', ''), 'address': ' '.join(x for x in (st.get('address', ''), st.get('city', '')) if x and not x.isdigit()), 'updated': index['updated'], 'items': rows}, f, ensure_ascii=False, separators=(',', ':'))
            index['branches'].append({'id': bid, 'name': label, 'chain': chain, 'chainName': CHAIN_NAME[chain], 'store': sid, 'count': len(rows), 'promos': sum(1 for r in rows if r[4])})
            log(f'{label}: {len(rows)} items, {index["branches"][-1]["promos"]} on promo')
        except Exception as e:
            log(f'{label}: failed: {type(e).__name__}: {e}')
    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)
    log(f'done: {len(index["branches"])}/{len(BRANCHES)} branches')


if __name__ == '__main__':
    main(set(sys.argv[1:]) or None)
