import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '@/lib/db/supabase';

export async function GET() {
  const checks: Record<string, string> = {};

  // 1. Check env vars exist
  checks['TELEGRAM_BOT_TOKEN'] = process.env.TELEGRAM_BOT_TOKEN ? '✅ set' : '❌ missing';
  checks['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY ? '✅ set' : '❌ missing';
  checks['SUPABASE_URL'] = process.env.SUPABASE_URL ? '✅ set' : '❌ missing';
  checks['SUPABASE_SERVICE_KEY'] = process.env.SUPABASE_SERVICE_KEY ? '✅ set' : '❌ missing';
  checks['ALLOWED_TELEGRAM_IDS'] = process.env.ALLOWED_TELEGRAM_IDS ?? '❌ missing';

  // 2. Test Supabase connection
  try {
    const { data, error } = await supabase.from('users').select('id, name').limit(5);
    if (error) {
      checks['supabase_users'] = `❌ ${error.message}`;
    } else {
      checks['supabase_users'] = `✅ ${JSON.stringify(data)}`;
    }
  } catch (e) {
    checks['supabase_users'] = `❌ ${e instanceof Error ? e.message : String(e)}`;
  }

  // 3. Test conversation_messages table
  try {
    const { error } = await supabase.from('conversation_messages').select('id').limit(1);
    checks['conversation_table'] = error ? `❌ ${error.message}` : '✅ exists';
  } catch (e) {
    checks['conversation_table'] = `❌ ${e instanceof Error ? e.message : String(e)}`;
  }

  // 4. Test Claude API
  try {
    const client = new Anthropic();
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say "ok" in one word' }],
    });
    const text = res.content[0]?.type === 'text' ? res.content[0].text : '?';
    checks['claude_api'] = `✅ ${text}`;
  } catch (e) {
    checks['claude_api'] = `❌ ${e instanceof Error ? e.message : String(e)}`;
  }

  return NextResponse.json(checks, { status: 200 });
}
