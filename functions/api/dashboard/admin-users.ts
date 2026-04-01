import type { Env } from '../../_lib/env';
import { getSupabaseAdmin } from '../../_lib/supabase';

const ADMIN_PASSWORD = 'nailthequoteangi26';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    // Simple password auth via header
    const authHeader = context.request.headers.get('X-Admin-Key');
    if (authHeader !== ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    // Debug: verify env vars are available
    if (!context.env.SUPABASE_URL || !context.env.SUPABASE_SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({
        error: 'Missing env vars',
        hasUrl: !!context.env.SUPABASE_URL,
        hasKey: !!context.env.SUPABASE_SERVICE_ROLE_KEY,
      }), { status: 500 });
    }

    const supabase = getSupabaseAdmin(context.env);

    // 1. Fetch all profiles (service role bypasses RLS)
    //    Profiles are created on account creation and reference auth.users(id)
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (profilesError) {
      return new Response(JSON.stringify({ error: 'Failed to load profiles', detail: profilesError.message }), { status: 500 });
    }

    // 2. Fetch all saved calculations
    const { data: calculations, error: calcsError } = await supabase
      .from('saved_calculations')
      .select('user_id, tool_slug, trade, label, created_at')
      .order('created_at', { ascending: false });
    if (calcsError) {
      return new Response(JSON.stringify({ error: 'Failed to load calculations', detail: calcsError.message }), { status: 500 });
    }

    // 3. Fetch all saved documents
    const { data: documents, error: docsError } = await supabase
      .from('saved_documents')
      .select('user_id, doc_type, client_name, amount, status, created_at')
      .order('created_at', { ascending: false });
    if (docsError) {
      return new Response(JSON.stringify({ error: 'Failed to load documents', detail: docsError.message }), { status: 500 });
    }

    // 4. Fetch email captures
    const { data: emailCaptures, error: emailError } = await supabase
      .from('email_captures')
      .select('*')
      .order('created_at', { ascending: false });
    if (emailError) {
      return new Response(JSON.stringify({ error: 'Failed to load email captures', detail: emailError.message }), { status: 500 });
    }

    // Build activity per user
    const activityMap: Record<string, { tools: Record<string, number>; totalCalcs: number; documents: any[]; lastActive: string }> = {};

    for (const calc of calculations || []) {
      if (!activityMap[calc.user_id]) {
        activityMap[calc.user_id] = { tools: {}, totalCalcs: 0, documents: [], lastActive: calc.created_at };
      }
      const key = `${calc.trade}/${calc.tool_slug}`;
      activityMap[calc.user_id].tools[key] = (activityMap[calc.user_id].tools[key] || 0) + 1;
      activityMap[calc.user_id].totalCalcs++;
    }

    for (const doc of documents || []) {
      if (!activityMap[doc.user_id]) {
        activityMap[doc.user_id] = { tools: {}, totalCalcs: 0, documents: [], lastActive: doc.created_at };
      }
      activityMap[doc.user_id].documents.push({
        type: doc.doc_type,
        client: doc.client_name,
        amount: doc.amount,
        status: doc.status,
        created_at: doc.created_at,
      });
    }

    // Build user objects from profiles
    const users = (profiles || []).map((profile: any) => {
      const activity = activityMap[profile.id] || { tools: {}, totalCalcs: 0, documents: [], lastActive: null };

      return {
        id: profile.id,
        email: profile.email,
        created_at: profile.created_at,
        // Profile fields
        business_name: profile.business_name || null,
        owner_name: profile.owner_name || null,
        trade: profile.trade || null,
        phone: profile.phone || null,
        address: profile.address || null,
        zip_code: profile.zip_code || null,
        license_number: profile.license_number || null,
        default_hourly_rate: profile.default_hourly_rate || null,
        default_markup: profile.default_markup || null,
        marketing_consent: profile.marketing_consent,
        // Activity
        tools_used: activity.tools,
        total_calculations: activity.totalCalcs,
        documents: activity.documents,
        last_active: activity.lastActive,
      };
    });

    return new Response(JSON.stringify({
      users,
      email_captures: emailCaptures || [],
      summary: {
        total_users: users.length,
        total_email_captures: (emailCaptures || []).length,
        total_calculations: (calculations || []).length,
        total_documents: (documents || []).length,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), { status: 500 });
  }
};
