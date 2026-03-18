import type { Env } from '../../_lib/env';
import { getSupabaseAdmin } from '../../_lib/supabase';

export const onRequestPost: PagesFunction<Env> = async (context) => {
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

    const body: any = await context.request.json();

    const { error } = await supabase.from('saved_calculations').insert({
      user_id: user.id,
      tool_slug: body.toolSlug,
      trade: body.trade,
      inputs: body.inputs,
      outputs: body.outputs,
      label: body.label || null,
      url: body.url || null,
      full_state: body.fullState || null,
    });

    if (error) {
      console.error('Save calc error:', JSON.stringify(error));
      return new Response(JSON.stringify({ error: 'Failed to save', detail: error.message || error.code }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    console.error('Save calc exception:', err?.message || err);
    return new Response(JSON.stringify({ error: 'Internal error', detail: err?.message }), { status: 500 });
  }
};

export const onRequestDelete: PagesFunction<Env> = async (context) => {
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

    const body: any = await context.request.json();
    if (!body.id) {
      return new Response(JSON.stringify({ error: 'Missing ID' }), { status: 400 });
    }

    const { error } = await supabase
      .from('saved_calculations')
      .delete()
      .eq('id', body.id)
      .eq('user_id', user.id); // Ensure user can only delete their own

    if (error) {
      return new Response(JSON.stringify({ error: 'Failed to delete' }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch {
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
};
