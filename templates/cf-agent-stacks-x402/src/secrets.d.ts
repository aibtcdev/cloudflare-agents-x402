// Secrets are not in wrangler.jsonc, so `wrangler types` only sees them when a local .dev.vars exists.
// Declaring them here keeps `npm run typecheck` working on a fresh clone (see .dev.vars.example).
// The generated worker-configuration.d.ts declares Env twice (global and Cloudflare.Env); both need the fields.
interface TemplateSecrets {
  WALLET_KEK: string;
  PAYER_PRIVATE_KEY?: string;
}
interface Env extends TemplateSecrets {}
declare namespace Cloudflare {
  interface Env extends TemplateSecrets {}
}
