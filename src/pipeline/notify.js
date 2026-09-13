import { q } from '../db.js';
import { setting } from '../llm.js';

const esc = (s = '') =>
  String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/**
 * Credentials come from config/settings.json (editable in the web Settings page),
 * falling back to the env vars - same precedence `setting()` already gives the
 * model overrides. With neither configured this prints to stdout instead, which
 * is what `npm run cli notify` did before Telegram was ever set up.
 */
export async function telegram(text) {
  const token = await setting('telegram_bot_token', 'TELEGRAM_BOT_TOKEN');
  const chat = await setting('telegram_chat_id', 'TELEGRAM_CHAT_ID');
  if (!token || !chat) { console.log('\n' + text.replace(/<[^>]+>/g, '')); return false; }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('telegram failed:', body);
    throw new Error(`telegram ${res.status}: ${body.slice(0, 200)}`);
  }
  return true;
}

export async function notify({ threshold = 0.75 } = {}) {
  const { rows } = await q(
    `SELECT id, company, title, location, url, score, verdict
     FROM jobs
     WHERE stage = 'scored' AND notified_at IS NULL AND score >= $1 AND closed_at IS NULL
     ORDER BY score DESC LIMIT 15`,
    [threshold]
  );
  if (!rows.length) return { sent: 0 };

  const lines = rows.map((j) => {
    const v = j.verdict || {};
    return `<b>${esc(j.title)}</b> — ${esc(j.company)}\n` +
           `${(j.score * 100).toFixed(0)}% · ${esc(j.location || 'n/a')}\n` +
           `${esc(v.verdict || '')}\n` +
           (v.gaps?.length ? `gaps: ${esc(v.gaps.slice(0, 2).join('; '))}\n` : '') +
           `<a href="${esc(j.url)}">posting</a> · <code>npm run cli tailor ${j.id}</code>`;
  });

  await telegram(`<b>${rows.length} new match${rows.length > 1 ? 'es' : ''}</b>\n\n${lines.join('\n\n')}`);
  await q(`UPDATE jobs SET notified_at = now() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
  return { sent: rows.length };
}
