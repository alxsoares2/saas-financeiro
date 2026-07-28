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

app.use("/webhook", webhookRouter);
app.use("/dre", dreRouter);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
});

export default app;
