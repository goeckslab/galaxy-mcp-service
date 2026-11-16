import { spawnSync } from "node:child_process";

// Synthetic report only: no Galaxy run, patient data or scientific claims.
export function reportPdf(): Buffer {
  const streams = [
    "BT /F1 18 Tf 40 730 Td (QC summary) Tj 0 -30 Td /F1 12 Tf (Sample     Reads     Retained) Tj 0 -20 Td (A          1000      900) Tj ET\n0.2 0.4 0.8 rg 60 200 60 200 re f 160 200 60 180 re f\nBT /F1 12 Tf 60 175 Td (Input     Retained) Tj ET",
    "BT /F1 18 Tf 40 730 Td (Limitations) Tj 0 -30 Td /F1 12 Tf (WARNING: sample B failed the quality threshold.) Tj 0 -30 Td (Source: synthetic teaching fixture, page 2.) Tj ET",
    "0.2 0.4 0.8 rg 60 200 60 200 re f 160 200 60 180 re f",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...streams.flatMap((stream, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ]),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

export function rasterImage(format: string, frames = 1): Buffer {
  const result = spawnSync("python3", ["-c", "from PIL import Image; import io, sys; frames=[Image.new('RGB', (20, 10), (20 + n * 30, 40, 80)) for n in range(int(sys.argv[2]))]; buffer=io.BytesIO(); frames[0].save(buffer, format=sys.argv[1], **({'save_all':True, 'append_images':frames[1:]} if len(frames)>1 else {})); sys.stdout.buffer.write(buffer.getvalue())", format, String(frames)]);
  if (result.status !== 0) throw new Error("Raster fixture requires Python 3 and Pillow.");
  return result.stdout;
}
