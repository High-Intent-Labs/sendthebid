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

    const supabase = getSupabaseAdmin(context.env);

    // 1. Fetch all auth users from Supabase (paginate to get all)
    let allAuthUsers: any[] = [];
    let page = 1;
    while (true) {
      const { data, error: authError } = await supabase.auth.admin.listUsers({
        page,
        perPage: 500,
      });
      if (authError) {
        return new Response(JSON.stringify({ error: 'Failed to list auth users', detail: authError.message }), { status: 500 });
      }
      const users = data?.users || [];
      allAuthUsers = allAuthUsers.concat(users);
      if (users.length < 500) break;
      page++;
    }

    // 2. Fetch all profiles
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (profilesError) {
      return new Response(JSON.stringify({ error: 'Failed to load profiles', detail: profilesError.message }), { status: 500 });
    }

    // 3. Fetch all saved calculations (grouped counts per user/tool)
    const { data: calculations, error: calcsError } = await supabase
      .from('saved_calculations')
      .select('user_id, tool_slug, trade, label, created_at')
      .order('created_at', { ascending: false });
    if (calcsError) {
      return new Response(JSON.stringify({ error: 'Failed to load calculations', detail: calcsError.message }), { status: 500 });
    }

    // 4. Fetch all saved documents
    const { data: documents, error: docsError } = await supabase
      .from('saved_documents')
      .select('user_id, doc_type, client_name, amount, status, created_at')
      .order('created_at', { ascending: false });
    if (docsError) {
      return new Response(JSON.stringify({ error: 'Failed to load documents', detail: docsError.message }), { status: 500 });
    }

    // 5. Fetch email captures
    const { data: emailCaptures, error: emailError } = await supabase
      .from('email_captures')
      .select('*')
      .order('created_at', { ascending: false });
    if (emailError) {
      return new Response(JSON.stringify({ error: 'Failed to load email captures', detail: emailError.message }), { status: 500 });
    }

    // Build profile map
    const profileMap: Record<string, any> = {};
    for (const p of profiles || []) {
      profileMap[p.id] = p;
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

    // Merge into user objects
    const users = allAuthUsers.map((authUser: any) => {
      const profile = profileMap[authUser.id] || {};
      const activity = activityMap[authUser.id] || { tools: {}, totalCalcs: 0, documents: [], lastActive: null };

      return {
        id: authUser.id,
        email: authUser.email,
        created_at: authUser.created_at,
        last_sign_in_at: authUser.last_sign_in_at,
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
        // Activity
        tools_used: activity.tools,
        total_calculations: activity.totalCalcs,
        documents: activity.documents,
        last_active: activity.lastActive,
      };
    });

    // Sort by most recently created
    users.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

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
