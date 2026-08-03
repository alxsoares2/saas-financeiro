// Registro de lojas (multi-tenant).
//
// Cada loja tem seu próprio banco Supabase (url + key) e é identificada pelo
// grupo do WhatsApp (grupoId). O app roteia cada mensagem pra loja certa.
//
// A loja PRIMÁRIA (ex: Mano) vem das env vars que já existem —
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GRUPO_FINANCEIRO_ID.
// Ela NÃO muda: continua funcionando exatamente como hoje.
//
// Lojas ADICIONAIS (ex: Basílico) vêm da env var TENANTS (JSON array).
// Assim você adiciona uma loja nova sem tocar na config da loja que já roda:
//   TENANTS=[{"id":"basilico","grupo":"120...-group","supabaseUrl":"https://yyy.supabase.co","supabaseKey":"eyJ..."}]

export interface Tenant {
  id: string;
  grupoId: string;
  url: string;
  key: string;
  schema: string;
}

let _cache: Tenant[] | null = null;

export function getTenants(): Tenant[] {
  if (_cache) return _cache;

  const tenants: Tenant[] = [];

  // 1. Loja primária (legado) — Mano, das env vars atuais
  if (process.env.SUPABASE_URL) {
    tenants.push({
      id: process.env.PRIMARY_TENANT_ID || "mano",
      grupoId: process.env.GRUPO_FINANCEIRO_ID ?? "",
      url: process.env.SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      schema: process.env.SUPABASE_SCHEMA || "financeiro",
    });
  }

  // 2. Lojas adicionais — Basílico e futuros, da env TENANTS
  const raw = process.env.TENANTS;
  if (raw && raw.trim()) {
    const arr = JSON.parse(raw);
    for (const t of arr) {
      tenants.push({
        id: t.id,
        grupoId: t.grupo ?? "",
        url: t.supabaseUrl,
        key: t.supabaseKey,
        schema: t.schema || "financeiro",
      });
    }
  }

  _cache = tenants;
  return _cache;
}

// Acha a loja dona de uma mensagem, comparando só os dígitos do grupo/telefone.
export function findTenantByChat(chatId?: string, phone?: string): Tenant | undefined {
  const tenants = getTenants();
  const chatNum = (chatId ?? "").replace(/\D/g, "");
  const phoneNum = (phone ?? "").replace(/\D/g, "");

  // Legado sem grupo configurado = processa tudo (comportamento antigo)
  if (tenants.length === 1 && !tenants[0].grupoId.replace(/\D/g, "")) {
    return tenants[0];
  }

  return tenants.find((t) => {
    const g = t.grupoId.replace(/\D/g, "");
    return g !== "" && (g === chatNum || g === phoneNum);
  });
}
