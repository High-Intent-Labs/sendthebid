import type { Env } from '../../_lib/env';
import { getSupabaseAdmin } from '../../_lib/supabase';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const supabase = getSupabaseAdmin(context.env);
    const authHeader = context.request.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }

    // Exclude document-type tools (shown separately under Documents)
    const docSlugs = ['invoice-generator', 'estimate-template', 'work-order-template',
      'service-agreement-template', 'subcontractor-agreement-template',
      'inspection-report-template', 'completion-report-template', 'receipt-template',
      'maintenance-checklist', 'service-checklist', 'inspection-checklist',
      'punch-list-template', 'treatment-checklist', 'change-order-template'];

    const { data, error } = await supabase
      .from('saved_calculations')
      .select('*')
      .eq('user_id', user.id)
      .not('tool_slug', 'in', `(${docSlugs.join(',')})`)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      return new Response(JSON.stringify({ error: 'Failed to load' }), { status: 500 });
    }

    return new Response(JSON.stringify(data || []), { status: 200 });
  } catch {
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
};
