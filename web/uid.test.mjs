/**
 * The bug this guards: bullet ids used to be numbered per-role with an
 * ARRAY-INDEX prefix, so deleting a role renumbered the survivors and the next
 * "add bullet" could mint an id another role already held. PUT /api/profile then
 * 400'd on its duplicate check and the whole editing session was lost.
 *
 * uid() is defined inline in profile.html (no build step, no modules), so this
 * keeps a copy in sync by shape. Run: node web/public/uid.test.mjs
 */
import assert from 'node:assert/strict';

function allIds(profile) {
  return [
    ...profile.experience.flatMap((e) => (e.bullets || []).map((b) => b.id)),
    ...profile.projects.map((p) => p.id),
    ...profile.education.map((e) => e.id),
    ...profile.stories.map((s) => s.id),
  ].filter(Boolean);
}

function uid(profile, prefix) {
  const ids = new Set(allIds(profile));
  let n = ids.size + 1;
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const profile = {
  experience: [
    { bullets: [{ id: 'b1' }, { id: 'b2' }] },
    { bullets: [{ id: 'fp1' }, { id: 'fp2' }] },
  ],
  projects: [{ id: 'pr1' }],
  education: [{ id: 'ed1' }],
  stories: [{ id: 'st1' }],
};

// A fresh id never collides with anything already in the profile.
const fresh = uid(profile, 'b');
assert.ok(!allIds(profile).includes(fresh), `${fresh} already exists`);

// The regression: remove the FIRST role, then add a bullet to what's left.
// The index-keyed scheme handed out 'b1' here - a duplicate of a surviving id
// whenever the shifted role happened to hold one.
profile.experience.shift();
profile.experience[0].bullets.push({ id: uid(profile, 'b') });
const ids = allIds(profile);
assert.equal(new Set(ids).size, ids.length, `duplicate id after removing a role: ${ids}`);

// Minting repeatedly stays unique as the set grows.
for (let i = 0; i < 50; i++) profile.projects.push({ id: uid(profile, 'pr') });
const after = allIds(profile);
assert.equal(new Set(after).size, after.length, 'duplicate id after repeated adds');

console.log('uid: ok');
