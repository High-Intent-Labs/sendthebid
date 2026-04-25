export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_API_KEY: string;
  RESEND_AUDIENCE_ID: string;
  // Tier B (email nurture sequence) additions:
  // Bearer token shared with the GitHub Actions cron that hits /api/email-scheduler.
  EMAIL_SCHEDULER_SECRET: string;
  // HMAC key for signing unsubscribe links (functions/_lib/unsubscribe-token.ts).
  UNSUBSCRIBE_SIGNING_KEY: string;
}
