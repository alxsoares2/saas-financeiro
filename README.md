# SaaS Financeiro — Gestor via WhatsApp

MVP de gestão financeira para PMEs. Recebe documentos (NF-e, boletos, fotos) via WhatsApp através do Z-API, extrai dados com Claude AI, salva no Supabase e gera DRE por Simples Nacional.

---

## Pré-requisitos

- Node.js 20+
- Conta no Supabase
- Instância Z-API ativa
- Chave da API Anthropic

---

## Configuração

### 1. Instalar dependências

```bash
npm install
```

### 2. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

```bash
cp .env.example .env
```

| Variável | Descrição |
|----------|-----------|
| `ZAPI_INSTANCE_ID` | ID da instância Z-API |
| `ZAPI_TOKEN` | Token da instância Z-API |
| `ZAPI_CLIENT_TOKEN` | Client-Token do Z-API (header de autenticação) |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service Role Key do Supabase |
| `ANTHROPIC_API_KEY` | Chave da API Anthropic |
| `WEBHOOK_SECRET` | Segredo para validar o webhook (opcional) |
| `GRUPO_FINANCEIRO_ID` | ID do grupo WhatsApp (ex: `5511999999999-1234567890@g.us`) |
| `PORT` | Porta do servidor (padrão: 3000) |

### 3. Supabase — criar tabelas e categorias

No painel do Supabase, vá em **SQL Editor** e rode em ordem:

```sql
-- Passo 1: schema
```
Cole o conteúdo de `migrations/001_schema.sql`

```sql
-- Passo 2: categorias iniciais
```
Cole o conteúdo de `migrations/002_seed_categorias.sql`

### 4. Supabase Storage — criar bucket

No painel do Supabase, vá em **Storage → New Bucket**:
- Nome: `documentos`
- Public: **sim** (para gerar URLs públicas de documentos)

---

## Rodando localmente

```bash
npm run dev
```

Para expor via ngrok (necessário para o webhook do Z-API):

```bash
ngrok http 3000
```

---

## Configurar webhook no Z-API

1. Acesse o painel Z-API da sua instância
2. Vá em **Webhooks**
3. Configure a URL: `https://SEU-NGROK.ngrok.io/webhook/zapi`
4. Marque os eventos: **Mensagens recebidas** (received)
5. Se configurou `WEBHOOK_SECRET`, adicione o header `X-Webhook-Secret: seu-segredo`

---

## Uso no WhatsApp

No grupo configurado (`GRUPO_FINANCEIRO_ID`), envie:

| Mensagem | Ação |
|----------|------|
| Foto de nota fiscal / boleto | Extrai e lança automaticamente |
| XML de NF-e como documento | Extrai com precisão (CNPJ, valor, data) |
| Descrição em texto ("paguei aluguel R$ 2000") | Extrai via Claude |
| `dre` | DRE do mês atual |
| `dre julho` | DRE de julho do ano atual |
| `dre 2024-07` | DRE de competência específica |
| `pendentes` | Lista de contas a pagar/receber |
| `ajuda` | Lista de comandos |

---

## API REST

### GET /dre

Retorna o DRE em JSON.

```
GET /dre?inicio=2024-07-01&fim=2024-07-31
```

### GET /health

```
GET /health
→ { "status": "ok", "ts": "..." }
```

---

## Testes

```bash
npm test
```

Cobre: parser de NF-e XML, cálculo do DRE, formatação para WhatsApp.

---

## Regime Tributário

Sistema configurado para **Simples Nacional**. O DRE usa uma única linha de dedução "DAS - Simples Nacional" (em vez de PIS/COFINS/ISS/IRPJ/CSLL separados).
