"""Non-executable report extraction. No networking, credentials or user-supplied commands."""

import base64
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import resource
import subprocess
import sys


MAX_IMAGE = 2_000_000
VOID = set("area base br col embed hr img input link meta param source track wbr".split())
BLOCKED = set("head script style noscript iframe object embed form template svg math canvas audio video".split())
BLOCKS = set("div p section article header footer h1 h2 h3 h4 h5 h6 ul ol li dl dt dd blockquote pre table caption tr br hr".split())


class ReportHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.parts = []
        self.figures = []
        self.image_data = {}
        self.figure_count = 0
        self.nodes = 0
        self.merged_cells = False

    def handle_starttag(self, tag, attrs):
        self.nodes += 1
        if self.nodes > 100_000 or len(self.stack) > 256:
            raise ValueError("HTML structure exceeds the safe extraction limit.")
        attrs = dict(attrs)
        blocked = (bool(self.stack) and self.stack[-1][1]) or tag in BLOCKED or "hidden" in attrs
        if tag not in VOID:
            self.stack.append((tag, blocked))
        if blocked:
            return
        if tag in BLOCKS:
            self.parts.append("\n")
        if re.fullmatch(r"h[1-6]", tag):
            self.parts.append("#" * int(tag[1]) + " ")
        if tag == "li":
            self.parts.append("- ")
        if tag in {"th", "td"}:
            self.parts.append("\t")
            self.merged_cells |= any(attrs.get(key, "1") != "1" for key in ("colspan", "rowspan"))
        if tag == "img":
            index = self.figure_count
            self.figure_count += 1
            if index >= 100:
                return
            alt = (attrs.get("alt") or "Figure")[:500]
            self.parts.append(f" [Figure {index}: {alt}] ")
            src = attrs.get("src") or ""
            match = re.fullmatch(r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)", src, re.I)
            available = False
            if match and len(match[2]) <= MAX_IMAGE * 4 // 3 + 100:
                try:
                    data = base64.b64decode(re.sub(r"\s", "", match[2]), validate=True)
                    kind = match[1].lower()
                    valid = ((kind == "png" and data.startswith(b"\x89PNG\r\n\x1a\n"))
                             or (kind == "jpeg" and data.startswith(b"\xff\xd8\xff"))
                             or (kind == "gif" and data[:6] in (b"GIF87a", b"GIF89a"))
                             or (kind == "webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP"))
                    if valid and len(data) <= MAX_IMAGE:
                        available = True
                        self.image_data[index] = {"mimeType": "image/" + kind, "data": base64.b64encode(data).decode()}
                except ValueError:
                    pass
            self.figures.append({"index": index, "label": alt, "available": available})

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if not self.stack or not self.stack[-1][1]:
            if tag in BLOCKS:
                self.parts.append("\n")
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if not self.stack or not self.stack[-1][1]:
            self.parts.append(data)


def command(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8).stdout


def read_report(path, options):
    fmt = options["format"]
    page = options["page"]
    limitations = []
    figures = []
    image = None
    page_count = 1
    figure_count = 0
    if fmt == "pdf":
        figure_count = None  # PDF figures are not enumerated; zero would claim their absence.
        if not path.read_bytes()[:1024].lstrip().startswith(b"%PDF-"):
            raise ValueError("The dataset is not a valid PDF document.")
        info = command(["pdfinfo", str(path)]).decode("utf-8", errors="replace")
        match = re.search(r"^Pages:\s+(\d+)", info, re.M)
        if not match:
            raise ValueError("PDF page count could not be determined.")
        page_count = int(match[1])
        if page > page_count:
            raise ValueError("Requested page is outside this PDF.")
        text_path = path.with_suffix(".txt")
        command(["pdftotext", "-f", str(page), "-l", str(page), "-layout", "-enc", "UTF-8", str(path), str(text_path)])
        if text_path.stat().st_size > 5_000_000:
            raise ValueError("PDF page text exceeds the safe extraction limit.")
        text = text_path.read_text(encoding="utf-8").replace("\f", "").strip()
        limitations.append("PDF text preserves approximate layout, not verified table cells; use the page image for columns, figures and footnotes.")
        if not text:
            limitations.append("No extractable text on this page. Request its image; OCR/visual interpretation depends on the client model.")
        if options["includeImage"]:
            prefix = path.parent / "page"
            command(["pdftoppm", "-f", str(page), "-l", str(page), "-singlefile", "-scale-to", "2000", "-png", str(path), str(prefix)])
            data = prefix.with_suffix(".png").read_bytes()
            if len(data) > MAX_IMAGE:
                limitations.append("Page image exceeds the 2 MB response limit and was omitted.")
            else:
                image = {"mimeType": "image/png", "data": base64.b64encode(data).decode()}
        else:
            limitations.append("Page image not requested; extracted text alone does not cover image-only evidence.")
    else:
        raw = path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.decode("utf-8-sig", errors="replace")
            limitations.append("Input is not valid UTF-8; replacement characters may obscure content.")
        if fmt == "html":
            parser = ReportHTML()
            parser.feed(text)
            parser.close()
            text = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", "".join(parser.parts)).strip()
            figures = parser.figures
            figure_count = parser.figure_count
            limitations.append("Static HTML extraction only: scripts, source styles, external assets and SVG/canvas/interactive charts are not executed or read.")
            if parser.merged_cells:
                limitations.append("HTML tables contain merged cells; tab-separated extraction does not expand their spans.")
            if figure_count > len(figures):
                limitations.append("Figure inventory is limited to the first 100 figures.")
            if options["includeImage"]:
                image = parser.image_data.get(options["imageIndex"])
                if image is None:
                    limitations.append("Requested figure is unavailable: only valid embedded raster images up to 2 MB can be returned.")
            if figure_count:
                limitations.append("Figures are not described by their alt text alone. Request relevant available figure images before interpreting them.")
        elif options["includeImage"]:
            limitations.append("This text report has no page image.")

    offset = options["offset"]
    if offset > len(text):
        raise ValueError("Text offset is outside this report page.")
    excerpt = text[offset:offset + options["maxChars"]]
    end = offset + len(excerpt)
    result = {
        "text": excerpt, "characters_returned": len(excerpt), "total_characters": len(text),
        "offset": offset, "truncated": offset > 0 or end < len(text) or page_count > 1,
        "has_more_text": end < len(text), "page": page, "page_count": page_count,
        "figures": figures, "figure_count": figure_count, "image_returned": image is not None,
        "limitations": limitations,
    }
    if end < len(text):
        result["next_offset"] = end
    if page < page_count:
        result["next_page"] = page + 1
    if image:
        result["image"] = image
    return result


if __name__ == "__main__":
    # Limits also apply to child PDF decoders. No source credentials enter this process.
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (12_000_000, 12_000_000))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    try:
        print(json.dumps(read_report(Path(sys.argv[1]), json.loads(sys.argv[2])), ensure_ascii=True))
    except FileNotFoundError:
        print(json.dumps({"error": "Report reader requires Python 3 and Poppler (pdfinfo, pdftotext, pdftoppm) on the service."}))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({"error": "Report decoding failed or exceeded its resource limit. No complete-content claim can be made."}))
