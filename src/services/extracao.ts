import { ZAPIPayload, ExtractedDocument, ExtracaoMultipla } from "../types.js";
import { downloadMedia } from "./zapi.js";
import { extractFromImage, extractFromPDF, extractFromText, extractMultiFromImageV2, extractMultiFromPDF } from "./claude.js";
import { extractFromNFeXml } from "./xml-nfe.js";
import { uploadDocument } from "../db/supabase.js";

export interface ExtracaoResult {
  // Entrada única — texto, XML NF-e
  extracted?: ExtractedDocument;
  // Múltiplos itens agrupados por categoria — imagens, PDFs
  multipla?: ExtracaoMultipla;
  urlArquivo?: string;
}

function isNFeXml(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "text/xml" || mimeType === "application/xml") return true;
  const sample = buffer.toString("utf-8", 0, 200);
  return sample.includes("<NFe") || sample.includes("<nfeProc");
}

export async function processar(payload: ZAPIPayload): Promise<ExtracaoResult | null> {
  // ── Texto livre ───────────────────────────────────────────────────────────
  if (payload.text?.message) {
    const msg = payload.text.message.trim();
    if (/^(dre|pendentes|ajuda|help)\b/i.test(msg)) return null;

    const extracted = await extractFromText(msg);
    if (!extracted) return null;
    return { extracted };
  }

  // ── Imagem — usa extração multi-item ─────────────────────────────────────
  const imageUrl = payload.image?.imageUrl ?? payload.image?.url;
  if (imageUrl) {
    const buffer = await downloadMedia(imageUrl);
    const mimeType = (payload.image!.mimeType || "image/jpeg") as
      | "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    const filename = `img_${payload.messageId}.jpg`;
    const urlArquivo = await uploadDocument(buffer, filename, mimeType);

    const multipla = await extractMultiFromImageV2(buffer, mimeType, payload.image!.caption);
    if (!multipla) return null;
    return { multipla, urlArquivo };
  }

  // ── Documento (PDF, XML NF-e) ─────────────────────────────────────────────
  const documentUrl = payload.document?.documentUrl ?? payload.document?.url;
  if (documentUrl) {
    const buffer = await downloadMedia(documentUrl);
    const mimeType = payload.document!.mimeType || "application/octet-stream";
    const filename = payload.document!.fileName ?? payload.document!.title ?? `doc_${payload.messageId}`;
    const urlArquivo = await uploadDocument(buffer, filename, mimeType);

    if (isNFeXml(buffer, mimeType)) {
      const extracted = await extractFromNFeXml(buffer.toString("utf-8"));
      if (!extracted) return null;
      return { extracted, urlArquivo };
    }

    if (mimeType === "application/pdf") {
      const multipla = await extractMultiFromPDF(buffer);
      if (!multipla) return null;
      return { multipla, urlArquivo };
    }

    // Outros formatos — tenta como imagem single-item
    const extracted = await extractFromImage(buffer, "image/jpeg");
    if (!extracted) return null;
    return { extracted, urlArquivo };
  }

  return null;
}
