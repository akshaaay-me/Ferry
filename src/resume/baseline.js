/**
 * A non-job-tailored resume selection: every bullet/project/skill from the
 * full profile, in the exact shape render.js already expects from tailor.js.
 * No LLM call - there's no posting to tailor against.
 */
export function baselineSelection(profile) {
  return {
    headline: profile.basics.headline,
    summary: '',
    experience: profile.experience.map((e) => ({
      company: e.company,
      role: e.role,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })),
    })),
    projects: profile.projects.map((p) => ({ id: p.id, name: p.name, text: p.text })),
    skills: profile.skills,
    cover_note: '',
  };
}
