import { LESSONS } from './lessons.js';
import { GLOSSARY, glossaryEntry } from './glossary.js';
import { validateLesson } from './engine.js';

export const BADGE_IDS = Object.freeze(['lesson-complete', 'all-lessons']);

export function validateAll() {
  const errors = [];
  for (const lesson of LESSONS) {
    const res = validateLesson(lesson);
    if (!res.ok) errors.push({ id: lesson.id, errors: res.errors });
    const text = JSON.stringify(lesson);
    const re = /\[\[([a-z0-9-]+)\|/g;
    let m;
    while ((m = re.exec(text))) if (!glossaryEntry(m[1])) errors.push({ id: lesson.id, errors: [`glossary ${m[1]}`] });
  }
  return { ok: errors.length === 0, errors, lessons: LESSONS, glossary: GLOSSARY };
}
