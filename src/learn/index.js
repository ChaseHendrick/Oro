import { LESSONS } from './lessons.js';
import { GLOSSARY, glossaryEntry } from './glossary.js';
import { validateLesson } from './engine.js';

export const BADGE_IDS = Object.freeze(['lesson-complete', 'all-lessons']);

export function glossaryLinks(lesson) {
  const ids = [];
  const re = /\[\[([A-Za-z0-9-]+)\|/g;
  const text = JSON.stringify(lesson);
  let m;
  while ((m = re.exec(text))) ids.push(m[1].toLowerCase());
  return ids;
}

export function validateAll() {
  const errors = [];
  for (const lesson of LESSONS) {
    const res = validateLesson(lesson);
    if (!res.ok) errors.push({ id: lesson.id, errors: res.errors });
    for (const id of glossaryLinks(lesson)) if (!glossaryEntry(id)) errors.push({ id: lesson.id, errors: [`glossary ${id}`] });
  }
  return { ok: errors.length === 0, errors, lessons: LESSONS, glossary: GLOSSARY };
}
