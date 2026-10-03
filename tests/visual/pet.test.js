// v2.9 the pet: wander, sleep and hop as pure logic.
import { describe, it, expect } from 'vitest';
import { createPet, petStep, petNote, petMode, petHopHeight, petName, PET, DEFAULT_PET_NAME } from '../../src/visual/pet.js';
import { mulberry32 } from '../../src/dsp/terrain-math.js';

const flat = () => 0;

describe('the pet', () => {
  it('wanders slowly on gentle land', () => {
    const pet = createPet(0.5, 0.5, 0);
    const rng = mulberry32(1);
    for (let i = 0; i < 100; i++) petStep(pet, 0.1, i * 0.1, flat, rng);
    expect(petMode(pet)).toBe('wander');
    const moved = Math.hypot(pet.u - 0.5, pet.v - 0.5);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(PET.speed * 10 + 1e-9);
  });

  it('walks slower with reduced motion', () => {
    const a = createPet(0.5, 0.5, 0), b = createPet(0.5, 0.5, 0);
    petStep(a, 0.5, 0.5, flat, () => 0.5);
    petStep(b, 0.5, 0.5, flat, () => 0.5, true);
    expect(Math.abs(b.u - 0.5)).toBeLessThan(Math.abs(a.u - 0.5));
  });

  it('turns away from steep ground instead of climbing it', () => {
    const pet = createPet(0.5, 0.5, 0, 0);
    const wall = (u) => (u > 0.51 ? 5 : 0);
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) petStep(pet, 0.1, i * 0.1, wall, rng);
    expect(pet.u).toBeLessThanOrEqual(0.51 + PET.lookAhead);
    expect(pet.blocked).toBeGreaterThan(0);
  });

  it('sleeps after a quiet while and wakes with a hop on a note', () => {
    const pet = createPet(0.5, 0.5, 0);
    const rng = mulberry32(2);
    petStep(pet, 0.1, PET.sleepAfter - 1, flat, rng);
    expect(petMode(pet)).toBe('wander');
    petStep(pet, 0.1, PET.sleepAfter + 0.1, flat, rng);
    expect(petMode(pet)).toBe('sleep');
    const u = pet.u;
    petStep(pet, 1, PET.sleepAfter + 1.1, flat, rng);
    expect(pet.u).toBe(u);
    petNote(pet, 30);
    expect(petMode(pet)).toBe('hop');
    petStep(pet, PET.hopTime / 2, 30 + PET.hopTime / 2, flat, rng);
    expect(petHopHeight(pet)).toBeCloseTo(PET.hopHeight, 5);
    petStep(pet, PET.hopTime, 31, flat, rng);
    expect(petMode(pet)).toBe('wander');
    expect(petHopHeight(pet)).toBe(0);
  });

  it('does not hop with reduced motion', () => {
    const pet = createPet(0.5, 0.5, 0);
    pet.state = 'sleep';
    petNote(pet, 5, true);
    expect(petMode(pet)).toBe('wander');
    expect(petHopHeight(pet)).toBe(0);
  });

  it('keeps a tidy name', () => {
    expect(petName('')).toBe(DEFAULT_PET_NAME);
    expect(petName('  Biscuit   the  Brave ')).toBe('Biscuit the Brave');
    expect(petName('x'.repeat(40))).toHaveLength(24);
  });
});
