import { describe, expect, it } from 'vitest';
import { completionPercent, EMPTY_PROGRESS, loadProgress, toggleBookmark, toggleCompleted, touchLesson } from './progress';

describe('course progress', () => {
  it('recovers safely from invalid storage', () => {
    expect(loadProgress('{broken')).toEqual(EMPTY_PROGRESS);
    expect(loadProgress(JSON.stringify({ version: 0, lessons: {} }))).toEqual(EMPTY_PROGRESS);
  });
  it('records activity without losing other flags', () => {
    const opened = touchLesson(EMPTY_PROGRESS, 'schema-one-to-many');
    const saved = toggleBookmark(opened, 'schema-one-to-many');
    const complete = toggleCompleted(saved, 'schema-one-to-many');
    expect(complete.lessons['schema-one-to-many']).toEqual({ opened: true, bookmarked: true, completed: true });
    expect(completionPercent(complete, 35)).toBe(3);
  });
});
