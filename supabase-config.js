/*
 * Configuração do ambiente UAT v3. Mantém deliberadamente a mesma base de
 * dados Supabase usada pelo UAT v2 enquanto a aplicação ainda não está live.
 *
 * Substitua apenas os dois valores de ligação pelos dados do projeto Supabase
 * pre-live. Nunca coloque aqui uma chave service_role ou a password da base
 * de dados.
 */
window.TEAM_JM_UAT_CONFIG = Object.freeze({
  supabaseUrl: 'https://ohdqtxxidftwmtjtgldx.supabase.co',
  supabaseAnonKey: 'sb_publishable_Y3cR7lbBmu3hwqf04H60CQ_E6hgsRRA',
  annualFee: 12,
  startYear: 2026,
  maxImportRows: 2000,
  pageSize: 500
});
