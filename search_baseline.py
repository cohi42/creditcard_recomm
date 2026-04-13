import sqlite3

conn = sqlite3.connect('cards.db')
cur = conn.execute("""
SELECT b.card_id, c.card_name, c.card_company, b.raw_info, b.common_notes
FROM v_benefits_for_recommendation b
JOIN cards c ON b.card_id = c.card_id
WHERE b.category = '카페'
AND b.effective_info NOT LIKE '%전월%'
AND b.effective_info NOT LIKE '%실적%'
AND b.effective_info NOT LIKE '%이용금액%'
AND b.effective_info NOT LIKE '%이용실적%'
AND b.effective_info NOT LIKE '%결제회수%'
""")
for row in cur:
    print(row[0], row[1], row[2])
conn.close()