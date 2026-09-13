import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { q } from '../db.js';
import { env } from '../config.js';

const run = promisify(execFile);
// Backslash-escape every character Typst treats as markup, so an LLM-rewritten
// bullet like "C++", "<1 ms latency" or "[embedded]" can't break `typst compile`
// (which would silently drop us to the HTML-only fallback).
const esc = (s = '') => String(s).replace(/([#$@\\_*`"~+<>[\]])/g, '\\$1');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * Dates are facts, not the LLM's to touch - the tailored selection omits them.
 * Look the role back up in the profile (by company, then role) and format its
 * period. "2025-06" -> "Jun 2025"; "Present" passes through.
 */
const fmtMonth = (s) => {
  const m = /^(\d{4})-(\d{2})$/.exec(s || '');
  if (!m) return s || '';
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1]} ${m[1]}`;
};
function periodFor(exp, profile) {
  if (exp.period) return exp.period;
  const src = (profile.experience || []).find(
    (e) => e.company === exp.company && (!exp.role || e.role === exp.role)
  ) || (profile.experience || []).find((e) => e.company === exp.company);
  if (!src || (!src.start && !src.end)) return '';
  return [fmtMonth(src.start), fmtMonth(src.end)].filter(Boolean).join(' – ');
}

function typstDoc(profile, sel) {
  const b = profile.basics;
  const contact = [b.email, b.phone, b.location, b.links?.github, b.links?.linkedin, b.links?.site]
    .filter(Boolean).map(esc).join(" #sym.dot.c ");

  const experience = (sel.experience || []).map((e) => `
*${esc(e.role)}*, ${esc(e.company)} #h(1fr) ${esc(periodFor(e, profile))}
${e.bullets.map((x) => `- ${esc(x.text)}`).join('\n')}
`).join('\n');

  const projects = (sel.projects || [])
    .map((p) => `- *${esc(p.name)}.* ${esc(p.text)}`).join('\n');

  const skills = Object.entries(sel.skills || profile.skills)
    .map(([k, v]) => `- *${esc(k)}:* ${v.map(esc).join(', ')}`).join('\n');

  const education = (profile.education || [])
    .map((e) => `- ${esc(e.degree)}, ${esc(e.school)} #h(1fr) ${esc(e.year)}`).join('\n');

  return `#set page(margin: (x: 1.6cm, y: 1.4cm))
#set text(font: "New Computer Modern", size: 10pt)
#set par(justify: false, leading: 0.62em)
#show heading.where(level: 2): it => block(above: 1.1em, below: 0.5em)[
  #text(size: 10.5pt, weight: "bold", upper(it.body))
  #v(-0.55em) #line(length: 100%, stroke: 0.5pt)
]

#align(center)[
  #text(size: 17pt, weight: "bold")[${esc(b.name)}] \\
  #text(size: 10pt)[${esc(sel.headline || b.headline)}] \\
  #text(size: 8.5pt)[${contact}]
]

${sel.summary ? `#v(0.3em)\n${esc(sel.summary)}\n` : ''}

== Experience
${experience}

== Selected Projects
${projects}

== Skills
${skills}

${education ? `== Education\n${education}` : ''}
`;
}

function htmlDoc(profile, sel) {
  const b = profile.basics;
  return `<!doctype html><meta charset="utf-8"><title>${b.name}</title>
<style>
 body{font:14px/1.5 Georgia,serif;max-width:44rem;margin:2.5rem auto;padding:0 1.5rem;color:#111}
 h1{font-size:1.7rem;margin:0;text-align:center} .sub,.contact{text-align:center;margin:.2rem 0}
 .contact{font-size:.8rem;color:#555}
 h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #999;padding-bottom:.2rem;margin:1.5rem 0 .6rem}
 li{margin:.25rem 0} .role{font-weight:700;margin-top:.7rem}
 @media print{body{margin:0;font-size:11px}}
</style>
<h1>${b.name}</h1>
<div class="sub">${sel.headline || b.headline}</div>
<div class="contact">${[b.email, b.phone, b.location, b.links?.github, b.links?.linkedin, b.links?.site].filter(Boolean).join(' · ')}</div>
${sel.summary ? `<p>${sel.summary}</p>` : ''}
<h2>Experience</h2>
${(sel.experience || []).map((e) => `<div class="role">${e.role}, ${e.company}${periodFor(e, profile) ? ` <span style="font-weight:400;color:#555">· ${periodFor(e, profile)}</span>` : ''}</div><ul>${e.bullets.map((x) => `<li>${x.text}</li>`).join('')}</ul>`).join('')}
<h2>Selected Projects</h2>
<ul>${(sel.projects || []).map((p) => `<li><b>${p.name}.</b> ${p.text}</li>`).join('')}</ul>
<h2>Skills</h2>
<ul>${Object.entries(sel.skills || profile.skills).map(([k, v]) => `<li><b>${k}:</b> ${v.join(', ')}</li>`).join('')}</ul>
<h2>Education</h2>
<ul>${(profile.education || []).map((e) => `<li>${e.degree}, ${e.school} (${e.year})</li>`).join('')}</ul>`;
}

export async function render({ job, selection, profile, resumeId }) {
  const dir = path.join(env.outDir, `${job.id}-${slugify(job.company)}-${slugify(job.title)}`);
  await fs.mkdir(dir, { recursive: true });

  const base = `${slugify(profile.basics.name)}-${slugify(job.company)}`;
  const htmlPath = path.join(dir, `${base}.html`);
  const typPath = path.join(dir, `${base}.typ`);
  const pdfPath = path.join(dir, `${base}.pdf`);

  await fs.writeFile(htmlPath, htmlDoc(profile, selection));
  await fs.writeFile(typPath, typstDoc(profile, selection));
  await fs.writeFile(path.join(dir, 'cover-note.txt'),
    `${selection.cover_note || ''}\n\n---\nPosting: ${job.url}\n`);
  await fs.writeFile(path.join(dir, 'selection.json'), JSON.stringify(selection, null, 2));

  let pdf = null;
  try {
    await run('typst', ['compile', typPath, pdfPath]);
    pdf = pdfPath;
  } catch {
    console.warn('  typst not available — open the .html and print to PDF instead');
  }

  if (resumeId) {
    await q(`UPDATE resumes SET pdf_path = $2, html_path = $3 WHERE id = $1`, [resumeId, pdf, htmlPath]);
  }
  return { dir, pdf, html: htmlPath };
}
