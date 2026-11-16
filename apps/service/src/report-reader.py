"""Non-executable report extraction. No networking, credentials or user-supplied commands."""

import base64
import csv
import gzip
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import re
import resource
import subprocess
import sys
import xml.etree.ElementTree as ET


MAX_IMAGE = 2_000_000
MAX_BYTES = 20_000_000
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


def image_page(path, page):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 16_000_000
    with Image.open(path) as source:
        if source.format not in {"PNG", "JPEG", "GIF", "WEBP", "BMP", "TIFF"}:
            raise ValueError("Unsupported image encoding; use the original file in Galaxy.")
        pages = getattr(source, "n_frames", 1)
        if not 1 <= page <= min(pages, 100_000):
            raise ValueError("Requested frame is outside this image.")
        source.seek(page - 1)
        if source.width * source.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError("Image dimensions exceed the safe preview limit.")
        image = ImageOps.exif_transpose(source).convert("RGBA")
        image.thumbnail((2000, 2000))
        for _ in range(5):
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            if buffer.tell() <= MAX_IMAGE:
                return {"mimeType": "image/png", "data": base64.b64encode(buffer.getvalue()).decode()}, pages
            image.thumbnail((max(1, image.width // 2), max(1, image.height // 2)))
    raise ValueError("Image cannot fit the safe preview size.")


def static_svg(raw):
    if len(raw) > MAX_IMAGE or re.search(br"<!\s*(?:DOCTYPE|ENTITY)", raw, re.I):
        raise ValueError("SVG exceeds the safe preview limit or contains a document type/entity.")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise ValueError("Invalid SVG document.") from error
    namespace = "{http://www.w3.org/2000/svg}"
    if root.tag not in {"svg", namespace + "svg"}:
        raise ValueError("The dataset is not an SVG image.")
    if sum(1 for _ in root.iter()) > 10_000:
        raise ValueError("SVG structure exceeds the safe preview limit.")
    allowed = set("svg g path rect circle ellipse line polygon polyline text tspan title desc defs linearGradient radialGradient stop clipPath mask".split())
    for parent in root.iter():
        for child in list(parent):
            if child.tag.removeprefix(namespace) not in allowed:
                parent.remove(child)
        for name, value in list(parent.attrib.items()):
            # No event handlers, source CSS, external references or embedded content.
            if name.lower().startswith("on") or name in {"style", "href", "src"} or name.startswith("{") or re.search(r"url\s*\((?!\s*#[\w.-]+\s*\))|(?:https?:|data:|javascript:)", value, re.I):
                del parent.attrib[name]
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    data = ET.tostring(root, encoding="utf-8")
    text = "\n".join("".join(node.itertext()) for node in root.iter() if node.tag.removeprefix(namespace) in {"text", "title", "desc"})
    return text, {"kind": "svg", "mimeType": "image/svg+xml", "data": base64.b64encode(data).decode()}


def table_preview(text, delimiter, partial):
    rows = []
    limited = partial
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, strict=True)
    try:
        for row in reader:
            if len(rows) == 50:
                limited = True
                break
            # A character excerpt may end in an incomplete record. Do not present it as a full row.
            if partial and not text.endswith("\n") and reader.line_num >= text.count("\n") + 1:
                limited = True
                break
            limited |= len(row) > 50 or any(len(cell) > 2000 for cell in row)
            rows.append([cell[:2000] for cell in row[:50]])
    except csv.Error:
        limited = True
    return {"kind": "table", "rows": rows, "limited": limited}


def read_report(path, options):
    fmt = options["format"]
    page = options["page"]
    limitations = []
    figures = []
    image = None
    preview = None
    kind = "text"
    source_limited = False
    page_count = 1
    figure_count = 0
    if fmt == "pdf":
        kind = "pdf"
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
        image_formats = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"}
        media_types = {"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "oga": "audio/ogg", "flac": "audio/flac", "m4a": "audio/mp4", "mp4": "video/mp4", "webm": "video/webm", "ogv": "video/ogg"}
        if fmt in image_formats or raw.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"II*\x00", b"MM\x00*", b"BM")) or (raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"):
            kind = "image"
            image, page_count = image_page(path, page)
            text = ""
            figure_count = 1
            if not options["includeImage"]:
                image = None
            limitations.append("Raster preview of the selected image/frame, fitted to 2000 pixels and 2 MB; not original numerical pixel data. Animations do not autoplay.")
        elif fmt in media_types:
            if page != 1 or len(raw) > MAX_IMAGE:
                raise ValueError("Audio/video preview is limited to 2 MB; open the original file in Galaxy.")
            valid = ((fmt in {"ogg", "oga", "ogv"} and raw.startswith(b"OggS"))
                     or (fmt == "wav" and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE")
                     or (fmt == "flac" and raw.startswith(b"fLaC"))
                     or (fmt == "mp3" and (raw.startswith(b"ID3") or (len(raw) > 1 and raw[0] == 255 and raw[1] & 224 == 224)))
                     or (fmt in {"mp4", "m4a"} and raw[4:8] == b"ftyp")
                     or (fmt == "webm" and raw.startswith(b"\x1aE\xdf\xa3")))
            if not valid:
                raise ValueError("Media encoding does not match the dataset format.")
            kind = media_types[fmt].split("/")[0]
            preview = {"kind": kind, "mimeType": media_types[fmt], "data": base64.b64encode(raw).decode()}
            text = ""
            limitations.append("Media is a UI-only native-player preview, without autoplay, transcription or model-visible audio/video evidence. Host codec/CSP support may vary.")
        elif fmt == "svg":
            if page != 1:
                raise ValueError("SVG uses a single page.")
            kind = "svg"
            text, preview = static_svg(raw)
            limitations.append("Static SVG preview: scripts, animation, embedded content, source CSS and external assets are removed. The model receives text labels, not raster visual evidence.")
        else:
            if page != 1:
                raise ValueError("Only PDFs and raster images have multiple pages/frames.")
            if raw.startswith(b"\x1f\x8b"):
                with gzip.open(path, "rb") as source:
                    raw = source.read(MAX_BYTES + 1)
                source_limited = len(raw) > MAX_BYTES
                raw = raw[:MAX_BYTES]
                if source_limited:
                    limitations.append("Only the first 20 MB of decompressed content was inspected; this is not the complete dataset.")
            if b"\x00" in raw or any(byte < 32 and byte not in {9, 10, 13} for byte in raw[:65536]) or raw.startswith((b"PK\x03\x04", b"\x89HDF", b"BAM\x01", b"CRAM", b"PAR1")):
                raise ValueError("Binary content requires Galaxy's datatype-specific summary or original file; it is not text.")
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                if fmt not in {"txt", "tabular", "csv", "tsv"}:
                    raise ValueError("Content is not readable UTF-8 text; use Galaxy's datatype-specific summary or original file.")
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
        elif kind == "text" and options["includeImage"]:
            limitations.append("This text report has no page image.")

    offset = options["offset"]
    if offset > len(text):
        raise ValueError("Text offset is outside this report page.")
    excerpt = text[offset:offset + options["maxChars"]]
    end = offset + len(excerpt)
    if kind == "text" and fmt != "html" and (fmt in {"csv", "tsv", "tabular", "bed", "gff", "gff3", "gtf", "vcf", "interval"} or ("\t" in excerpt and "\n" in excerpt)):
        kind = "table"
        preview = table_preview(excerpt, "," if fmt == "csv" else "\t", end < len(text) or source_limited)
        limitations.append("Table preview is bounded to 50 rows, 50 columns and 2000 characters per cell per text excerpt. No header or column types are inferred.")
    result = {
        "text": excerpt, "characters_returned": len(excerpt), "total_characters": len(text),
        "offset": offset, "truncated": source_limited or offset > 0 or end < len(text) or page_count > 1,
        "has_more_text": end < len(text), "page": page, "page_count": page_count,
        "figures": figures, "figure_count": figure_count, "image_returned": image is not None,
        "limitations": limitations,
        "preview_kind": kind,
    }
    if end < len(text):
        result["next_offset"] = end
    if page < page_count:
        result["next_page"] = page + 1
    if image:
        result["image"] = image
    if preview:
        result["preview"] = preview
    return result


if __name__ == "__main__":
    # Limits also apply to child PDF decoders. No source credentials enter this process.
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (12_000_000, 12_000_000))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    try:
        print(json.dumps(read_report(Path(sys.argv[1]), json.loads(sys.argv[2])), ensure_ascii=True))
    except (FileNotFoundError, ImportError):
        print(json.dumps({"error": "Report reader requires Python 3, Pillow and Poppler (pdfinfo, pdftotext, pdftoppm) on the service."}))
    except ValueError as error:
        print(json.dumps({"error": str(error)}))
    except (OSError, subprocess.SubprocessError):
        print(json.dumps({"error": "Report decoding failed or exceeded its resource limit. No complete-content claim can be made."}))
