#!/usr/bin/env python3
"""
Парсит подневный график Коммерцов (B2B) из "Sternmeister расписание
менеджеров (N).xlsx", лист "Sheet3" — единственный лист в этом файле с
РЕАЛЬНЫМ подневным графиком по МОПам (🌴 = выходной, 1 = рабочий день,
пусто = ещё не запланировано на эту дату).

НЕ путать с листом "Расписание" в том же файле — это шаблон Госников (B2G),
к графику Коммерцов отношения не имеет (см.
dev_docs/specs/24-SLA-РАБОЧИЕ-ЧАСЫ-ОТКРЫТЫЙ-ВОПРОС.md).

Формат листа: строка 1 — дни недели, строка 2 — номера дней 1..31 (колонка E
= день 1), строки 3+ — по менеджеру: колонка B = имя, колонки E.. = статус.

Usage:
  python scripts/parse-b2b-schedule-xlsx.py "<путь к xlsx>" <YYYY-MM> <output.json>

Выход — JSON-список {name, date, status: "work"|"off"} (пустые ячейки
пропущены). Дальше грузится в БД скриптом
scripts/import-b2b-schedule-from-json.ts.
"""
import json
import sys

import openpyxl


def main() -> None:
    if len(sys.argv) != 4:
        print(f"Usage: {sys.argv[0]} <xlsx path> <YYYY-MM> <output.json>", file=sys.stderr)
        sys.exit(1)
    xlsx_path, month_str, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    ws = wb["Sheet3"]

    out = []
    for row in ws.iter_rows(min_row=3):
        vals = [c.value for c in row]
        name = (vals[1] or "").strip() if len(vals) > 1 else ""
        if not name:
            continue
        for day in range(1, 32):
            idx = 3 + day  # column E (index 4, 0-based) = day 1
            if idx >= len(vals):
                break
            cell = vals[idx]
            if cell is None or cell == "":
                continue
            status = "work" if cell in (1, 1.0, "1") else "off"
            out.append({"name": name, "date": f"{month_str}-{day:02d}", "status": status})

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"Written {len(out)} entries to {out_path}")


if __name__ == "__main__":
    main()
