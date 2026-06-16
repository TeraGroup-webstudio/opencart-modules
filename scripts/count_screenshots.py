#!/usr/bin/env python3
"""
Reads index.html, counts actual screenshot files in each module/theme folder,
and updates the badge numbers (🖼 N скриншотів) automatically.

Rules:
- If the folder has a 'Налаштування' subfolder → count images there recursively
  (module settings screenshots live there)
- Otherwise → count image files directly in the folder
  (personal cabinet themes store screenshots at the root level)
"""

import re
from pathlib import Path

IMAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}


def count_screenshots(folder: Path) -> int:
    if not folder.exists():
        return 0

    settings_dir = folder / 'Налаштування'
    if settings_dir.exists() and settings_dir.is_dir():
        return sum(
            1 for f in settings_dir.rglob('*')
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS
        )

    return sum(
        1 for f in folder.iterdir()
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS
    )


def replace_card(match: re.Match) -> str:
    card = match.group(0)

    href_m = re.search(r'href="([^"]+)"', card)
    if not href_m:
        return card

    href = href_m.group(1).lstrip('./').rstrip('/')
    folder = Path(href)
    count = count_screenshots(folder)

    if count == 0:
        return card

    updated = re.sub(r'(🖼 )\d+( скриншотів)', rf'\g<1>{count}\g<2>', card)
    if updated != card:
        print(f'  {folder.name}: {count} скриншотів')
    return updated


def main():
    index = Path('index.html')
    html = index.read_text(encoding='utf-8')
    original = html

    html = re.sub(r'<a class="card".*?</a>', replace_card, html, flags=re.DOTALL)

    if html != original:
        index.write_text(html, encoding='utf-8')
        print('index.html оновлено.')
    else:
        print('Змін немає.')


if __name__ == '__main__':
    main()
