// Fotos pro Marcos ler. Toda foto que chega no grupo financeiro é salva no
// Storage (bucket "documentos") ANTES da leitura automática, com o ID da
// mensagem do WhatsApp no nome ("<timestamp>_img_<messageId>.jpg" — ver
// services/extracao.ts). Então, mesmo quando a leitura automática falhou e a
// foto não virou lançamento, dá pra achar a imagem pelo ID e mandar pro
// Claude ler direto.
import type Anthropic from "@anthropic-ai/sdk";
import { getClient } from "../../db/supabase.js";

// Limite da API da Anthropic por imagem é 5 MB em base64; foto de WhatsApp
// costuma ter 100–500 KB, então isso só barra caso estranho.
const MAX_BYTES_IMAGEM = 3.5 * 1024 * 1024;
const TIPOS_ACEITOS = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export type BlocoImagem = Anthropic.Beta.BetaImageBlockParam;

// Busca a foto salva de uma mensagem. null = não está no Storage (foto de antes
// do sistema, ou que nunca chegou pelo webhook).
export async function imagemDaMensagem(messageId: string): Promise<BlocoImagem | null> {
  const id = messageId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!id) return null;

  // A busca do Storage é por prefixo e o nome começa com timestamp — então
  // lista os mais recentes e filtra pelo ID no nome.
  const storage = getClient().storage.from("documentos");
  const { data: arquivos, error } = await storage.list("", { limit: 1000, sortBy: { column: "created_at", order: "desc" } });
  if (error) throw new Error(`Erro ao listar fotos salvas: ${error.message}`);
  const arquivo = (arquivos ?? []).find((f: any) => f.name.includes(`_img_${id}`));
  if (!arquivo) return null;

  const mime = String(arquivo.metadata?.mimetype ?? "image/jpeg");
  if (!TIPOS_ACEITOS.has(mime)) return null;
  const { data: blob, error: errDown } = await storage.download(arquivo.name);
  if (errDown || !blob) throw new Error(`Erro ao baixar foto salva: ${errDown?.message ?? "vazia"}`);
  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.length > MAX_BYTES_IMAGEM) return null;

  return {
    type: "image",
    source: { type: "base64", media_type: mime as "image/jpeg", data: buffer.toString("base64") },
  };
}
