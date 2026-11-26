"""Render an MP4 walkthrough from one CLI run. Requires Pillow, DejaVu Sans and ffmpeg."""
import argparse
import hashlib
import html
import re
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1280, 720
INK, MUTED, GREEN = "#142C35", "#46616A", "#116B54"
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")


def readable(markdown):
    text = re.sub(r"\\([\\`*_\[\]~])", r"\1", markdown)
    return html.unescape(text)


def source_excerpt(text):
    text = re.sub(r"^[-*+]\s+", "", text)
    return re.sub(r"(\*\*|`)(.+?)\1", r"\2", text)


def run_details(report, source, log):
    def match(pattern, text=report):
        result = re.search(pattern, text, flags=re.M)
        if not result:
            raise ValueError(f"В отчёте или журнале отсутствует поле {pattern}")
        return result.group(1)

    def field(label):
        return readable(match(rf"^\| {re.escape(label)} \| (.+?) \|$")).strip("`")

    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if digest != field("SHA-256 файла") or source.name != field("Файл"):
        raise ValueError("Документ не соответствует файлу в паспорте прогона")
    model = field("Провайдер и модель")
    if match(r"^Модель — (.+)$", log).replace(" / ", " · ") != model:
        raise ValueError("Журнал и отчёт относятся к разным моделям")
    stages = re.findall(r"^(?:Выделение требований|Проверка отдельных требований \([^)]+\)|Проверка набора требований)$", log, re.M)
    if (len(stages) < 3 or stages[0] != "Выделение требований" or stages[-1] != "Проверка набора требований"
            or not re.search(r"^Отчёт сохранён в .+$", log, re.M)):
        raise ValueError("В журнале нет завершённого прогона")
    metrics = []
    for label in ("Требований в каталоге", "Нарушений", "Критический уровень"):
        metrics.append(int(match(rf"^- {label} — \*\*(\d+)\*\*")))
    verdicts = re.findall(r"^\*\*(Разработка(?: и тестирование)?|Тестирование)\*\* · (.+)$", report, re.M)
    if not verdicts:
        raise ValueError("В отчёте отсутствует итог о готовности документа")
    # The report's decision list orders by severity, then favors cross-requirement findings.
    first = re.search(r"^- \[(D\d+)\]\(#\1\)", report, re.M)
    finding = None
    if first:
        ident = first.group(1)
        block = report.split(f'<a id="{ident}"></a>', 1)[1]
        block = re.split(r'^<a id="|^#{2,3} ', block, maxsplit=1, flags=re.M)[0]
        quotes = re.findall(r"^> \*\*(.+?)\*\* · (.+)$", block, re.M)
        if not quotes:
            raise ValueError("Для выбранного дефекта отсутствуют цитаты")
        finding = {
            "id": ident,
            "title": readable(match(rf"^\*\*{ident} · (.+)\*\*$", block)),
            "question": readable(match(r"^\*\*Что уточнить\*\* · (.+)$", block)),
            "check": readable(match(r"^\*\*Проверка после ответа\*\* · (.+)$", block)),
            "quotes": [(location, source_excerpt(readable(quote))) for location, quote in quotes],
        }
    if bool(metrics[1]) != bool(finding):
        raise ValueError("Количество замечаний не согласуется с очередью вопросов")
    return dict(title=field("Документ"), model=model, date=field("Дата и время (UTC)"),
                version=field("Версия агента"), stages=stages, metrics=metrics, verdicts=verdicts, finding=finding)


def font(size, bold=False, mono=False):
    name = "DejaVuSansMono" if mono else "DejaVuSans"
    return ImageFont.truetype(str(FONT_DIR / (name + ("-Bold" if bold else "") + ".ttf")), size)


def paragraph(draw, x, y, text, size, width, limit, *, bold=False, color=INK, mono=False):
    face = font(size, bold, mono)
    lines = [""]
    # Split unbroken source IDs, URLs and long tokens at the visible edge too.
    for word in text.split():
        candidate = (lines[-1] + " " + word).strip()
        if draw.textlength(candidate, font=face) <= width:
            lines[-1] = candidate
            continue
        if lines[-1]:
            lines.append("")
        for char in word:
            if draw.textlength(lines[-1] + char, font=face) > width:
                lines.append("")
            lines[-1] += char
    if len(lines) > limit:
        lines = lines[:limit]
        while lines[-1] and draw.textlength(lines[-1] + "…", font=face) > width:
            lines[-1] = lines[-1][:-1]
        lines[-1] = lines[-1].rstrip() + "…"
    for line in lines:
        draw.text((x, y), line, font=face, fill=color, anchor="lt")
        y += size + 10
    return y


def frame(heading, subheading, footer, preview):
    image = Image.new("RGB", (WIDTH, HEIGHT), "#F4F7F5")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, WIDTH, 8), fill=GREEN)
    draw.text((64, 45), "BCC MNU   /   АГЕНТ ПРОВЕРКИ ТРЕБОВАНИЙ", font=font(20, True), fill=GREEN, anchor="lt")
    if preview:
        draw.text((1216, 45), "ТЕСТОВЫЙ ПРИМЕР", font=font(18, True), fill=MUTED, anchor="rt")
    paragraph(draw, 64, 102, heading, 46, 1152, 1, bold=True)
    paragraph(draw, 66, 172, subheading, 24, 1144, 2, color=MUTED)
    draw.line((64, 643, 1216, 643), fill="#B8CCC4", width=2)
    paragraph(draw, 64, 660, footer, 18, 1152, 1, color=MUTED)
    return image, draw


def card(draw, top, bottom, label, text, *, size=29, lines=2):
    draw.rounded_rectangle((64, top, 1216, bottom), 18, fill="#FFFFFF", outline="#CDDBD5", width=2)
    paragraph(draw, 91, top + 18, label, 19, 1094, 1, color=GREEN, bold=True)
    paragraph(draw, 91, top + 56, text, size, 1094, lines)


def render(data, preview):
    footer = f'{data["model"]}   •   UTC {data["date"][:19].replace("T", " ")}   •   версия {data["version"][:12]}'
    def page(title, subtitle):
        return frame(title, subtitle, footer, preview)

    frames = []
    img, draw = page("От спецификации к отчёту", data["title"])
    draw.rounded_rectangle((64, 242, 1216, 468), 18, fill=INK)
    paragraph(draw, 92, 269, "Команда прогона", 20, 1060, 1, bold=True, color="#9AE2C5")
    for i, line in enumerate(("node validator.mjs \\", "  --input inputs/requirements.md \\", "  --output output/report.md")):
        draw.text((92, 316 + i * 44), line, font=font(28, mono=True), fill="white", anchor="lt")
    paragraph(draw, 66, 502, "Из журнала запуска", 21, 1100, 1, bold=True, color=GREEN)
    paragraph(draw, 66, 543, "  →  ".join((data["stages"][0], data["stages"][-2], data["stages"][-1])),
              25, 1140, 2)
    frames.append((img, 9))

    finding = data["finding"]
    if finding:
        img, draw = page("Что обнаружил агент", finding["id"] + "   /   " + finding["title"])
        for i, (where, quote) in enumerate(finding["quotes"][:2]):
            start = 246 + 190 * i
            card(draw, start, start + 177, "Исходный документ  ·  " + where, quote, size=25, lines=3)
        frames.append((img, 16))

        img, draw = page("Какое решение нужно команде", finding["id"] + "   /   " + finding["title"])
        card(draw, 245, 423, "Вопрос владельцу продукта", finding["question"], size=27, lines=3)
        card(draw, 437, 621, "Как QA проверит ответ", finding["check"], size=27, lines=3)
        frames.append((img, 16))
    img, draw = page("Можно ли начинать разработку?", "Вывод и сводка из файла report.md")
    for i, (label, count) in enumerate(zip(("Требований", "Замечаний", "Критических"), data["metrics"])):
        left = 64 + 390 * i
        draw.rounded_rectangle((left, 245, left + 370, 391), 18, fill=INK)
        draw.text((left + 25, 269), str(count), font=font(48, True), fill="white", anchor="lt")
        draw.text((left + 25, 343), label, font=font(23), fill="#A6DFCD", anchor="lt")
    if len(data["verdicts"]) == 1:
        label, verdict = data["verdicts"][0]
        card(draw, 421, 619, label, verdict, size=28, lines=3)
    else:
        for i, (label, verdict) in enumerate(data["verdicts"]):
            y = 408 + i * 112
            paragraph(draw, 66, y, label, 20, 1138, 1, color=GREEN, bold=True)
            paragraph(draw, 66, y + 33, verdict, 25, 1138, 2)
    frames.append((img, 12))
    return frames


def write_video(frames, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as tmp:
        work = Path(tmp)
        playlist = []
        for i, (image, seconds) in enumerate(frames):
            image.save(work / f"{i}.png")
            playlist.extend([f"file '{i}.png'", f"duration {seconds}"])
        playlist.append(f"file '{len(frames)-1}.png'")
        (work / "frames.txt").write_text("\n".join(playlist) + "\n")
        subprocess.run(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "1", "-i", "frames.txt",
                        "-vf", "fps=24,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast",
                        "-movflags", "+faststart", "demo.mp4"], check=True, cwd=work)
        (work / "demo.mp4").replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "report", "log", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--preview", action="store_true", help="Mark all frames as a test example")
    args = parser.parse_args()
    details = run_details(args.report.read_text(encoding="utf-8"), args.source, args.log.read_text(encoding="utf-8"))
    write_video(render(details, args.preview), args.output)
