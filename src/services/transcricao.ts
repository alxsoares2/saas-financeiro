// Transcrição de áudio do WhatsApp (mensagem de voz) pra texto — usado pelo
// assistente Marcos. O Claude não recebe áudio, então a transcrição é feita
// pela OpenAI (mesma chave já usada na leitura de cupons).
//
// Modelo: gpt-4o-mini-transcribe — US$ 0,003/minuto (set/2026), o mais
// barato da tabela; áudio de WhatsApp em português fala claro o bastante.
import OpenAI, { toFile } from "openai";

const MODELO_TRANSCRICAO = "gpt-4o-mini-transcribe";
// Áudio mais longo que isso não é transcrito (custo e tempo de resposta) —
// ninguém dita pedido financeiro de 5 minutos.
export const MAX_SEGUNDOS_AUDIO = 300;

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });
  return _client;
}

export async function transcreverAudio(buffer: Buffer, mimeType = "audio/ogg"): Promise<string> {
  // WhatsApp manda voz em ogg/opus; a extensão do nome é o que a API usa pra
  // reconhecer o formato.
  const ext = mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") || mimeType.includes("m4a") ? "m4a" : "ogg";
  const transcrever = async (model: string) =>
    getClient().audio.transcriptions.create({
      file: await toFile(buffer, `audio.${ext}`, { type: mimeType.split(";")[0] }),
      model,
      language: "pt",
      // Ajuda a acertar nomes próprios e termos que aparecem no grupo.
      prompt: "Conversa de restaurante: Marcos, Fiuza, Mano, Basílico, nota, conciliação, DRE, reais.",
    });
  try {
    return ((await transcrever(MODELO_TRANSCRICAO)).text ?? "").trim();
  } catch (err) {
    // Se o modelo principal recusar (modelo indisponível na conta, formato),
    // tenta o whisper-1, mais antigo e aceito em qualquer conta.
    console.error(`[Transcrição] ${MODELO_TRANSCRICAO} falhou, tentando whisper-1:`, err instanceof Error ? err.message : err);
    return ((await transcrever("whisper-1")).text ?? "").trim();
  }
}
