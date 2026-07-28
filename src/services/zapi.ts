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

// Envia mensagem de texto para um chat/grupo
export async function sendTextMessage(chatId: string, text: string): Promise<void> {
  const phone = chatId.replace(/@.*/, ""); // Z-API aceita só o número
  await axios.post(
    `${instanceBase()}/send-text`,
    { phone, message: text },
    { headers: zapiHeaders(), timeout: 15_000 }
  );
}
