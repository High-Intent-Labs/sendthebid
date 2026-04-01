import type { Env } from '../../_lib/env';

const ADMIN_PASSWORD = 'nailthequoteangi26';

async function supabaseQuery(env: Env, table: string, select: string, orderBy?: string) {
  let url = `${env.SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  if (orderBy) url += `&order=${orderBy}`;

  const res = await fetch(url, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} ${text}`);
  }

  return res.json();
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const authHeader = context.request.headers.get('X-Admin-Key');
    if (authHeader !== ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const env = context.env;

    // Fetch data sequentially to avoid intermittent DNS resolution issues
    const profiles = await supabaseQuery(env, 'profiles', '*', 'created_at.desc');
    const calculations = await supabaseQuery(env, 'saved_calculations', 'user_id,tool_slug,trade,label,created_at', 'created_at.desc');
    const documents = await supabaseQuery(env, 'saved_documents', 'user_id,doc_type,client_name,amount,status,created_at', 'created_at.desc');
    const emailCaptures = await supabaseQuery(env, 'email_captures', '*', 'created_at.desc');

    // Build activity per user
    const activityMap: Record<string, { tools: Record<string, number>; totalCalcs: number; documents: any[]; lastActive: string }> = {};

    for (const calc of calculations) {
      if (!activityMap[calc.user_id]) {
        activityMap[calc.user_id] = { tools: {}, totalCalcs: 0, documents: [], lastActive: calc.created_at };
      }
      const key = `${calc.trade}/${calc.tool_slug}`;
      activityMap[calc.user_id].tools[key] = (activityMap[calc.user_id].tools[key] || 0) + 1;
      activityMap[calc.user_id].totalCalcs++;
    }

    for (const doc of documents) {
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
    const users = profiles.map((profile: any) => {
      const activity = activityMap[profile.id] || { tools: {}, totalCalcs: 0, documents: [], lastActive: null };

      return {
        id: profile.id,
        email: profile.email,
        created_at: profile.created_at,
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
        tools_used: activity.tools,
        total_calculations: activity.totalCalcs,
        documents: activity.documents,
        last_active: activity.lastActive,
      };
    });

    return new Response(JSON.stringify({
      users,
      email_captures: emailCaptures,
      summary: {
        total_users: users.length,
        total_email_captures: emailCaptures.length,
        total_calculations: calculations.length,
        total_documents: documents.length,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), { status: 500 });
  }
};
