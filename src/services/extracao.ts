import { ZAPIPayload, ExtractedDocument } from "../types.js";
import { downloadMedia } from "./zapi.js";
import { extractFromImage, extractFromPDF, extractFromText } from "./claude.js";
import { extractFromNFeXml } from "./xml-nfe.js";
import { uploadDocument } from "../db/supabase.js";

export interface ExtracaoResult {
  extracted: ExtractedDocument;
  urlArquivo?: string;
  rawBuffer?: Buffer;
  mimeType?: string;
  filename?: string;
}

// Detecta se o buffer de um documento é um XML de NF-e
function isNFeXml(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "text/xml" || mimeType === "application/xml") return true;
  const sample = buffer.toString("utf-8", 0, 200);
  return sample.includes("<NFe") || sample.includes("<nfeProc");
}

export async function processar(payload: ZAPIPayload): Promise<ExtracaoResult | null> {
  // ── Mensagem de texto ─────────────────────────────────────────────────────
  if (payload.text?.message) {
    const msg = payload.text.message.trim();

    // Comandos de consulta não precisam de extração (tratados na rota)
    const comandos = /^(dre|pendentes|ajuda|help)\b/i;
    if (comandos.test(msg)) return null;

    const extracted = await extractFromText(msg);
    return { extracted };
  }

  // ── Imagem ────────────────────────────────────────────────────────────────
  if (payload.image?.url) {
    const buffer = await downloadMedia(payload.image.url);
    const mimeType = (payload.image.mimeType || "image/jpeg") as
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "image/gif";
    const filename = `img_${payload.messageId}.jpg`;

    const urlArquivo = await uploadDocument(buffer, filename, mimeType);
    const extracted = await extractFromImage(buffer, mimeType);

    return { extracted, urlArquivo, rawBuffer: buffer, mimeType, filename };
  }

  // ── Documento (PDF, XML, etc.) ────────────────────────────────────────────
  if (payload.document?.url) {
    const buffer = await downloadMedia(payload.document.url);
    const mimeType = payload.document.mimeType || "application/octet-stream";
    const filename =
      payload.document.fileName ??
      payload.document.title ??
      `doc_${payload.messageId}`;

    const urlArquivo = await uploadDocument(buffer, filename, mimeType);

    let extracted: ExtractedDocument;

    if (isNFeXml(buffer, mimeType)) {
      extracted = await extractFromNFeXml(buffer.toString("utf-8"));
    } else if (mimeType === "application/pdf") {
      extracted = await extractFromPDF(buffer);
    } else {
      // Tenta como imagem se for tipo de imagem desconhecido
      extracted = await extractFromImage(buffer, "image/jpeg");
    }

    return { extracted, urlArquivo, rawBuffer: buffer, mimeType, filename };
  }

  return null;
}
