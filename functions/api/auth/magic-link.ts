import type { Env } from '../../_lib/env';
import { getSupabaseAdmin } from '../../_lib/supabase';
import { getResend, getAudienceId } from '../../_lib/resend';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const { email, marketingConsent, trigger, trade, toolSlug }: any = await context.request.json();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400 });
    }

    const supabase = getSupabaseAdmin(context.env);

    // Send magic link via Supabase Auth
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: 'https://nailthequote.com/auth/callback',
        data: {
          marketing_consent: marketingConsent,
          signup_trigger: trigger,
        },
      },
    });

    if (error) {
      console.error('Magic link error:', error);
      return new Response(JSON.stringify({ error: 'Failed to send login link' }), { status: 500 });
    }

    // Add to Resend Audience if consented
    if (marketingConsent) {
      const resend = getResend(context.env);
      const audienceId = getAudienceId(context.env);
      if (audienceId) {
        await resend.contacts.create({
          audienceId,
          email,
          unsubscribed: false,
          firstName: '',
          lastName: '',
        }).catch(() => {}); // Non-blocking
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error('Auth error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
};
