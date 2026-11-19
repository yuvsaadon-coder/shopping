# בדיקות למפענחי קבצי שקיפות המחירים (בלי רשת)
import gzip, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import branch_prices as bp

stores = bp.records(bp.parse_xml(gzip.compress('''<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><STORES>
<STORE><STOREID>413</STOREID><STORENAME>שלי תלפיות</STORENAME><ADDRESS>פייר קניג 1</ADDRESS><CITY>ירושלים</CITY></STORE>
<STORE><STOREID>9</STOREID><STORENAME>דיל תלפיות מזרח</STORENAME><ADDRESS>x</ADDRESS><CITY>ירושלים</CITY></STORE>
<STORE><STOREID>77</STOREID><STORENAME>ניות</STORENAME><ADDRESS>הנרייטה סולד</ADDRESS><CITY>ירושלים</CITY></STORE>
</STORES></asx:values></asx:abap>'''.encode())), ['storeid', 'storename'])
assert [s['storeid'] for s in bp.match_store(stores, ['תלפיות'], ['מזרח'])] == ['413']
assert bp.match_store(stores, ['ניות'], [])[0]['storeid'] == '77'
# UTF-16 (אושר עד וכו')
st16 = bp.records(bp.parse_xml('<?xml version="1.0" encoding="utf-16"?><Root><Stores><Store><StoreId>5</StoreId><StoreName>אושר עד גבעת שאול</StoreName></Store></Stores></Root>'.encode('utf-16')), ['storeid', 'storename'])
assert st16[0]['storeid'] == '5'

prices = bp.parse_prices(bp.parse_xml('''<root><Items>
<Item><ItemCode>7290000000001</ItemCode><ItemName>  טופו   טבעי </ItemName><ItemPrice>11.90</ItemPrice><Quantity>300.00</Quantity><UnitQty>גרם</UnitQty><UnitOfMeasurePrice>3.97</UnitOfMeasurePrice><UnitOfMeasure>100 גרם</UnitOfMeasure></Item>
<Item><ItemCode>7290000000002</ItemCode><ItemName>ללא מחיר</ItemName><ItemPrice>0</ItemPrice></Item>
<Item><ItemCode>7290000000003</ItemCode><ItemName>ביצים L</ItemName><ItemPrice>26.5</ItemPrice></Item>
</Items></root>'''.encode()))
assert prices['7290000000001'][:4] == ['טופו טבעי', 11.9, '300 גרם', '3.97 ל100 גרם'], prices['7290000000001']
assert '7290000000002' not in prices
bp.parse_promos(bp.parse_xml('''<root><Promotions>
<Promotion><PromotionDescription>2 ב-20</PromotionDescription><PromotionEndDate>2099-01-01</PromotionEndDate><PromotionItems><Item><ItemCode>7290000000001</ItemCode></Item></PromotionItems></Promotion>
<Promotion><PromotionDescription>ישן</PromotionDescription><PromotionEndDate>2000-01-01</PromotionEndDate><PromotionItems><Item><ItemCode>7290000000003</ItemCode></Item></PromotionItems></Promotion>
</Promotions></root>'''.encode()), prices, '2026-11-19')
assert prices['7290000000001'][4] == '2 ב-20' and prices['7290000000003'][4] == ''

class FakeCerb(bp.Cerberus):
    def __init__(self, names): self.names = names
c = FakeCerb(['PriceFull7290058140886-001-039-202611180500.gz', 'PriceFull7290058140886-001-039-202611190500.gz', 'PriceFull7290058140886-001-040-202611200500.gz', 'Stores7290058140886-202611190500.xml'])
assert c.latest('PriceFull', '39') == 'PriceFull7290058140886-001-039-202611190500.gz'
assert c.latest('Stores') == 'Stores7290058140886-202611190500.xml'
c2 = FakeCerb(['StoresFull7290103152017-000-202611190000.xml', 'PriceFull7290103152017-001-202611190000.gz', 'PriceFull7290103152017-012-202611190000.gz', 'PromoFull7290103152017-012-202611190000.gz'])
assert c2.latest('Stores') == 'StoresFull7290103152017-000-202611190000.xml'
assert c2.latest('PriceFull', '12') == 'PriceFull7290103152017-012-202611190000.gz'
assert c2.latest('PriceFull', '1') == 'PriceFull7290103152017-001-202611190000.gz'
print('branch prices: ok')
