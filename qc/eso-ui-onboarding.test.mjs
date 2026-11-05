import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnboardingStore } from '../eso/ui/apps/control-plane/src/app/features/onboarding/state/onboarding.store.ts';
import { DEFAULT_PROFILE } from '../eso/ui/apps/control-plane/src/app/features/onboarding/models/onboarding.model.ts';

test('ESO-390 UI: profile-first steps validate profile, consumer and configuration', () => {
  const store = new OnboardingStore();
  assert.equal(store.step(), 1);
  assert.deepEqual(store.profile().zones.map((z) => z.name), ['human', 'agent']);
  assert.equal(store.profile().profile.recipe, 'pro');
  assert.equal(store.validateStep(), null);

  assert.equal(store.next(), true);
  assert.equal(store.step(), 2);
  assert.match(store.validateStep(), /Consumer id/);
  store.patch({ id: 'acme', name: 'Acme', root: '/tmp/acme' });
  assert.equal(store.validateStep(), null);

  assert.equal(store.next(), true);
  assert.equal(store.step(), 3);
  store.patch({ sdlcRoot: '' });
  assert.match(store.validateStep(), /SDLC root/);
  store.patch({ sdlcRoot: 'sdlc' });
  store.patchZone(0, 'path', 'docs');
  assert.equal(store.profile().zones[0].path, 'docs');
  assert.equal(store.validateStep(), null);
  assert.equal(store.next(), true);
  assert.equal(store.step(), 4);
});

test('ESO-390 UI: profile recipe drives evidence sources', () => {
  const store = new OnboardingStore();
  assert.equal(store.profile().profile.recipe, 'pro');
  store.selectRecipe('lite');
  assert.equal(store.profile().profile.recipe, 'lite');
  assert.deepEqual(store.profile().sources, { docgraph: false, codegraph: false, memory: false });
  store.selectRecipe('pro');
  assert.deepEqual(store.profile().sources, { docgraph: true, codegraph: true, memory: true });
});

test('ESO-390 UI: roles, gates, sources and protected paths are editable data', () => {
  const store = new OnboardingStore();
  const roleCount = store.profile().team.roles.length;
  store.toggleRole('operator');
  assert.equal(store.profile().team.roles.length, roleCount + 1);
  store.toggleRole('operator');
  assert.equal(store.profile().team.roles.length, roleCount);

  store.toggleGate('release');
  assert.equal(store.profile().gates.release, false);
  store.toggleSource('memory');
  assert.equal(store.profile().sources.memory, true);
  store.setProtectedPaths('AGENTS.md\nsdlc/\n');
  assert.deepEqual(store.profile().protectedPaths, ['AGENTS.md', 'sdlc/']);
  assert.match(store.protectedPathsText(), /sdlc\//);

  store.reset();
  assert.equal(store.step(), 1);
  assert.equal(store.profile().id, DEFAULT_PROFILE.id);
  assert.equal(store.profile().gates.release, true);
});
