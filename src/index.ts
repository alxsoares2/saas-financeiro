import "dotenv/config";
import express from "express";
import webhookRouter from "./routes/webhook.js";
import dreRouter from "./routes/dre.js";

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// Rota de diagnóstico — responde imediatamente com dados do ambiente
app.get("/diag", (_req, res) => {
  const url = process.env.SUPABASE_URL ?? "NOT_SET";
  const keyStart = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "NOT_SET").substring(0, 20);
  res.json({ url, keyStart, node: process.version, ts: new Date().toISOString() });
});

// Rota para testar o fetch do Supabase assincronamente
app.get("/diag2", async (_req, res) => {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${url}/rest/v1/lancamentos?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Accept-Profile": "financeiro" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await r.text();
    res.json({ status: r.status, body: body.substring(0, 200) });
  } catch (e: any) {
    clearTimeout(timer);
    res.json({ error: e.message, cause: String(e.cause), name: e.name });
  }
});

app.use("/webhook", webhookRouter);
app.use("/dre", dreRouter);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
});

export default app;
