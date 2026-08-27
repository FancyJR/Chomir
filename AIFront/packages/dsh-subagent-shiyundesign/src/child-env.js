/**
 * Build the child `chomircode-agent` environment.
 *
 * On Mac/Windows (外网), forward the user's DSH-stored `DEEPSEEK_API_KEY` so the
 * subagent uses the same key as the parent model — not chat-pasted secrets.
 *
 * On Linux intranet, skip `credentials.resolve()` because kylin-intranet-ak
 * replaces every resolved key with the whitelist AK (wrong for api.deepseek.com).
 * The child still reads `AIFront/.env.local` on startup.
 */

/** @param {NodeJS.ProcessEnv} [env] @param {NodeJS.Platform} [platform] */
export function shouldForwardDshCredentials(env = process.env, platform = process.platform) {
  if (env.KYLIN_SKIP_INTRANET_AK === '1') return true
  if (env.KYLIN_FORCE_INTRANET_AK === '1') return false
  return platform !== 'linux'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, string>} configEnv
 */
export async function resolveChildEnv(ctx, configEnv) {
  const env = { ...configEnv }
  if (!shouldForwardDshCredentials()) return env
  if (env.DEEPSEEK_API_KEY) return env
  const credentials = ctx.credentials
  if (credentials?.resolve === undefined) return env
  const hit = await credentials.resolve('DEEPSEEK_API_KEY')
  if (hit?.value) env.DEEPSEEK_API_KEY = hit.value
  return env
}
