const supabase = require('./dist/db/supabase');

const codigos = ['D4936F', '888BBB', '45232E', '70C3CC', '33A606'];

(async () => {
  console.log('🔄 Marcando 5 lançamentos como pago...\n');

  for (const codigo of codigos) {
    try {
      const lanc = await supabase.getLancamentoPorCodigo(codigo.toLowerCase());

      if (!lanc) {
        console.log(`❌ ${codigo}: Não encontrado`);
        continue;
      }

      const resultado = await supabase.marcarComoPago(lanc.id);

      if (resultado) {
        console.log(`✅ ${codigo}: ${lanc.descricao} — R$ ${lanc.valor} → PAGO`);
      } else {
        console.log(`⚠️  ${codigo}: Não conseguiu marcar (já estava pago?)`);
      }
    } catch (err) {
      console.log(`❌ ${codigo}: Erro — ${err.message}`);
    }
  }

  console.log('\n✅ Tudo corrigido! Agora /pendentes deve estar vazio ou só com realmente pendentes.');
  process.exit(0);
})().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
