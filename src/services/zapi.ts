import axios from "axios";

const BASE_URL = "https://api.z-api.io/instances";

function zapiHeaders() {
  return {
    "Client-Token": process.env.ZAPI_CLIENT_TOKEN!,
  };
}

function instanceBase() {
  const id = process.env.ZAPI_INSTANCE_ID!;
  const token = process.env.ZAPI_TOKEN!;
  return `${BASE_URL}/${id}/token/${token}`;
}

// Baixa a mídia de uma URL fornecida pelo Z-API no payload do webhook
export async function downloadMedia(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    headers: zapiHeaders(),
    timeout: 30_000,
  });
  return Buffer.from(response.data);
}

function toPhone(chatId: string): string {
  if (chatId.includes("@g.us")) return chatId.replace("@g.us", "-group");
  return chatId.replace(/@.*/, "");
}

// Envia mensagem de texto para um chat/grupo
export async function sendTextMessage(chatId: string, text: string): Promise<void> {
  const phone = toPhone(chatId);
  console.log("[Z-API] sendTextMessage → phone:", phone, "texto:", text.slice(0, 40));
  try {
    const res = await axios.post(
      `${instanceBase()}/send-text`,
      { phone, message: text },
      { headers: zapiHeaders(), timeout: 15_000 }
    );
    console.log("[Z-API] resposta:", res.status, JSON.stringify(res.data).slice(0, 100));
  } catch (err: any) {
    console.error("[Z-API] erro sendTextMessage:", err?.response?.status, err?.response?.data ?? err?.message);
    throw err;
  }
}

// Envia documento (PDF, etc.) via base64
export async function sendDocumentMessage(
  chatId: string,
  buffer: Buffer,
  fileName: string,
  mimeType = "application/pdf"
): Promise<void> {
  const phone = toPhone(chatId);
  const base64 = buffer.toString("base64");
  const ext = fileName.split(".").pop() ?? "pdf";
  // Z-API exige prefixo data URI; fileName sem extensão (Z-API adiciona via extension)
  const dataUri = `data:${mimeType};base64,${base64}`;
  const fileNameSemExt = fileName.replace(/\.[^.]+$/, "");
  try {
    await axios.post(
      `${instanceBase()}/send-document/base64`,
      { phone, document: dataUri, extension: ext, fileName: fileNameSemExt },
      { headers: { ...zapiHeaders(), "Content-Type": "application/json" }, timeout: 60_000 }
    );
  } catch (err: any) {
    console.error("[Z-API] erro sendDocumentMessage:", err?.response?.status, err?.response?.data ?? err?.message);
    throw err;
  }
}
