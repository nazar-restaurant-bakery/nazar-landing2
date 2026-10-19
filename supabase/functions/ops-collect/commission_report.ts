import { NAZAR_BUSINESS, type Commission } from "./contracts.ts";

function pdfText(value: unknown) {
  return String(value ?? "unknown").normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("ı", "i").replace(/[^\x20-\x7e]/g, "?").slice(0, 160);
}
function escapePdf(line: string) { return line.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)"); }
export function createCommissionPdf(data: Commission): Uint8Array {
  if (data.business_id !== NAZAR_BUSINESS || !/^\d{4}-\d{2}-01$/.test(data.period_month)
    || ![data.qualified_sales, data.baseline, data.refunds, data.qicr, data.rate, data.commission_amount].every(Number.isFinite)) throw new Error("invalid_commission_report");
  const cash = (value: number) => `$${value.toFixed(2)}`;
  const lines = ["NAZAR RESTAURANT & BAKERY", "Monthly commission statement", `Period: ${data.period_month.slice(0, 7)}`,
    `Coverage: ${data.period_start || "unknown"} to ${data.period_end || "unknown"}`,
    "Qualified Clover net sales: tax and tips excluded; Uber Eats / Grubhub excluded.",
    "CSV net already includes refunds. Refunds are NOT deducted a second time.",
    `Qualified net sales: ${cash(data.qualified_sales)}`, `Baseline: ${cash(data.baseline)}`,
    `Additional refunds deduction: ${cash(data.refunds)}`, `QICR (sales minus baseline): ${cash(data.qicr)}`,
    `Rate: ${(data.rate * 100).toFixed(2)}%`, `Commission: ${cash(data.commission_amount)}`,
    `Source: ${data.source_file || "unknown"}`, `Collected: ${data.collected_at || "unknown"}`, `Computed: ${data.computed_at}`,
    "A partial period is an estimate until the full month is reconciled.", "Calculation only; not an invoice or payment authorization.", "This is not a profit or marketing-attribution report."];
  // Conservative fixed-width wrapping keeps long source filenames on one page
  // without allowing arbitrary provider/customer content into a PDF command.
  const wrapped = lines.flatMap(line => pdfText(line).match(/.{1,44}(?:\s|$)|.{1,44}/g)?.map(part => part.trim()) || [""]);
  if (wrapped.length > 45) throw new Error("commission_report_too_long");
  const content = `BT /F1 10 Tf 48 790 Td 16 TL\n${wrapped.map((line, index) => `${index ? "T* " : ""}(${escapePdf(line)}) Tj`).join("\n")}\nET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let output = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}
