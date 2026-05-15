import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "db" / "cards.db"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row

# 1) view가 존재하는지 확인
views = conn.execute(
    "SELECT name FROM sqlite_master WHERE type='view'"
).fetchall()
print("=== 등록된 View 목록 ===")
for v in views:
    print(f"  - {v['name']}")

# 2) 평가 대상 카드 7장에 대해 혜택 + 유의사항이 같이 나오는지 확인
# docs/sampled_cafe_cate.md의 카드 ID들
card_ids = [10, 45, 74, 105, 161, 208, 231, 263, 405, 574]

print("\n=== v_benefits_for_recommendation 확인 ===")
for cid in card_ids:
    rows = conn.execute(
        """SELECT benefit_id, category, 
                  length(effective_info) as info_len,
                  common_notes IS NOT NULL as has_notes,
                  common_note_count
           FROM v_benefits_for_recommendation 
           WHERE card_id = ? AND category = '카페'""",
        (cid,)
    ).fetchall()
    
    if rows:
        for r in rows:
            print(f"  card {cid} | benefit {r['benefit_id']} | "
                  f"info {r['info_len']}자 | "
                  f"유의사항 {'O' if r['has_notes'] else 'X'} "
                  f"({r['common_note_count']}건)")
    else:
        print(f"  card {cid} | 카페 카테고리 없음")

# 3) 유의사항이 실제로 붙었는지 샘플 1건 출력
print("\n=== 샘플 출력 (card 10) ===")
sample = conn.execute(
    """SELECT effective_info FROM v_benefits_for_recommendation 
       WHERE card_id = 10 AND category = '카페' LIMIT 1"""
).fetchone()
if sample:
    print(sample['effective_info'][:500])

rows = conn.execute(
    """SELECT benefit_id, raw_info 
       FROM benefits 
       WHERE card_id = 208 AND category = '카페'"""
).fetchall()
for r in rows:
    print(f"benefit {r['benefit_id']}:")
    print(r['raw_info'][:200])
    print("---")

# 1) 다른 카드에도 중복이 있는지
dupes = conn.execute(
    """SELECT card_id, category, COUNT(*) as cnt, 
              GROUP_CONCAT(benefit_id) as ids
       FROM benefits 
       GROUP BY card_id, category, raw_info 
       HAVING cnt > 1
       ORDER BY cnt DESC
       LIMIT 20"""
).fetchall()
print("=== 동일 raw_info 중복 건 ===")
for d in dupes:
    print(f"  card {d['card_id']} | {d['category']} | {d['cnt']}건 | ids: {d['ids']}")

# 2) benefit_id 범위 확인 (적재가 2회 돌았는지)
stats = conn.execute(
    """SELECT MIN(benefit_id) as min_id, MAX(benefit_id) as max_id, 
              COUNT(*) as total FROM benefits"""
).fetchone()
print(f"\n=== benefit_id 범위 ===")
print(f"  min: {stats['min_id']}, max: {stats['max_id']}, total: {stats['total']}")

conn.close()
