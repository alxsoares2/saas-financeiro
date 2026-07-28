# Prompt para o Claude Code

Copie tudo abaixo da linha e cole no Claude Code dentro da pasta do projeto.

---

Quero construir um gestor financeiro que recebe documentos pelo WhatsApp (via Z-API) e gera o DRE da minha empresa. Construa o MVP completo neste projeto.

## Stack
- Node.js + TypeScript (Express ou Fastify)
- Supabase como banco (Postgres) — use o client `@supabase/supabase-js`
- API do Claude (`@anthropic-ai/sdk`) para extrair dados de imagens e PDFs de documentos fiscais
- Variáveis de ambiente em `.env` (crie um `.env.example`): `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `WEBHOOK_SECRET`, `GRUPO_FINANCEIRO_ID`

## Fluxo
1. Endpoint `POST /webhook/zapi` recebe o webhook "Ao receber" da Z-API.
2. Processar SOMENTE mensagens do grupo cujo ID está em `GRUPO_FINANCEIRO_ID` (campo `phone`/`chatId` do payload). Ignorar o resto respondendo 200.
3. Idempotência: gravar o `messageId` e ignorar mensagens já processadas (a Z-API pode entregar duplicado).
4. Tipos de mensagem:
   - **Imagem ou PDF** (foto de nota fiscal, boleto, conta de água/luz/telefone): baixar a mídia pela URL do payload e enviar para a API do Claude (modelo claude-sonnet, com visão) pedindo extração em JSON: `{ tipo_documento, fornecedor, cnpj_cpf, descricao, valor_total, data_emissao, data_vencimento, categoria_sugerida, numero_documento }`.
   - **XML de NF-e**: parsear direto (sem IA) — emitente, destinatário, valor, data, itens.
   - **Texto** tipo "paguei 250 de gasolina hoje": extrair lançamento via Claude também.
5. Classificar automaticamente no plano de contas (tabela `categorias`) e gravar o lançamento.
6. Responder no próprio grupo (via API de envio da Z-API) confirmando: "✅ Registrado: Conta de água — R$ 142,50 — venc. 10/08 — categoria: Despesas Administrativas". Se a extração ficar com confiança baixa, responder pedindo confirmação.

## Banco (crie as migrations SQL para o Supabase)
- `lancamentos`: id, message_id (unique), tipo (receita/despesa), descricao, fornecedor, cnpj_cpf, valor, data_emissao, data_vencimento, data_pagamento, categoria_id, status (pendente/pago), url_arquivo, dados_brutos jsonb, created_at
- `categorias`: id, nome, grupo_dre (ex.: receita_bruta, deducoes, custos, despesas_operacionais, despesas_administrativas, despesas_financeiras), tipo
- `mensagens_processadas`: message_id, processed_at
- Seed inicial de categorias comuns de PME brasileira (água, energia, telefone/internet, aluguel, salários, impostos, fornecedores, combustível, etc.)
- Salvar o arquivo original no Supabase Storage (bucket `documentos`)

## DRE
- Endpoint `GET /dre?inicio=YYYY-MM-DD&fim=YYYY-MM-DD` que retorna o DRE estruturado: Receita Bruta → (−) Deduções/Impostos → Receita Líquida → (−) Custos → Lucro Bruto → (−) Despesas Operacionais/Administrativas → (−) Despesas Financeiras → Resultado Líquido, com totais por categoria.
- Comando no grupo: se alguém mandar "dre julho" ou "dre 07/2026", o bot responde com o DRE resumido formatado como mensagem de texto no WhatsApp.
- Também um comando "pendentes" que lista contas a pagar não vencidas e vencidas.

## Requisitos técnicos
- Estrutura organizada: `src/routes`, `src/services` (zapi, claude, extracao, dre), `src/db`
- Validar o header/token do webhook (`WEBHOOK_SECRET` ou Client-Token da Z-API)
- Logs claros de cada mensagem processada e tratamento de erros (nunca derrubar o webhook — sempre responder 200 e logar falhas)
- README em português com: como criar o projeto no Supabase, rodar as migrations, configurar o webhook "Ao receber" no painel da Z-API, descobrir o ID do grupo, e rodar localmente com ngrok para testes
- Testes básicos do parser de XML de NF-e e do cálculo do DRE

Comece criando a estrutura do projeto e as migrations, depois o webhook, depois a extração com IA, e por último o DRE. Me pergunte o regime tributário da empresa antes de definir as deduções do DRE.
