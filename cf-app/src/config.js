// The instance's settings, from wrangler.jsonc `vars` and `wrangler secret` (env), with the same
// names and defaults as the Node server's environment (docs/SELF_HOSTING.md).
const on = v => /^(1|true|yes|on)$/i.test(String(v || ''));
const notOff = v => !/^(0|false|no|off)$/i.test(String(v || ''));

export function configFrom(env) {
  const ORIGIN = String(env.ORIGIN || 'http://localhost:8787').replace(/\/+$/, '');
  const SECURE = /^https:/i.test(ORIGIN) ? ' Secure;' : '';
  const APP_BASE = String(env.BASE_PATH || '').replace(/\/+$/, '');
  return {
    ORIGIN,
    RP_ID: env.RP_ID || new URL(ORIGIN).hostname,
    RP_NAME: env.RP_NAME || 'openGym',
    SECRET: String(env.SESSION_SECRET || '').trim(),
    SECURE,
    ADMIN_UIDS: String(env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean),
    INVITE_ONLY: on(env.INVITE_ONLY),
    FIRST_USER_ADMIN: on(env.FIRST_USER_ADMIN),
    ALLOW_GUEST: notOff(env.ALLOW_GUEST),
    SESSION_DAYS: Math.max(1, +(env.SESSION_DAYS || 90) || 90),
    SAME_SITE: /^strict$/i.test(env.SESSION_SAMESITE || '') ? 'Strict' : 'Lax',
    DEFAULT_LANG: /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(String(env.DEFAULT_LANG || '').trim()) ? String(env.DEFAULT_LANG).trim() : '',
    API_TOKENS: notOff(env.API_TOKENS),
    MCP_ON: on(env.MCP),
    TOKEN_READS_PER_MIN: Math.max(1, +(env.TOKEN_READS_PER_MIN || 120) || 120),
    TOKEN_WRITES_PER_HOUR: Math.max(1, +(env.TOKEN_WRITES_PER_HOUR || 60) || 60),
    OAUTH_ANON_PER_MIN: Math.max(1, +(env.OAUTH_ANON_PER_MIN || 30) || 30),
    APP_BASE,
    OAUTH_ORIGIN: ORIGIN + APP_BASE,
    MCP_RESOURCE: ORIGIN + APP_BASE + '/mcp',
    env,
  };
}
