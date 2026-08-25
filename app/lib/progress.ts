export const STORAGE_KEY = 'sql-mastery-progress-v1';

export interface LessonProgress { completed: boolean; bookmarked: boolean; opened: boolean }
export interface ProgressState { version: 1; lessons: Record<string, LessonProgress>; lastOpened?: string }
export const EMPTY_PROGRESS: ProgressState = { version: 1, lessons: {} };
const emptyLesson = (): LessonProgress => ({ completed: false, bookmarked: false, opened: false });

export function loadProgress(raw: string | null): ProgressState {
  if (!raw) return EMPTY_PROGRESS;
  try {
    const value = JSON.parse(raw) as ProgressState;
    return value?.version === 1 && value.lessons && typeof value.lessons === 'object' ? value : EMPTY_PROGRESS;
  } catch { return EMPTY_PROGRESS; }
}

export function touchLesson(state: ProgressState, id: string): ProgressState {
  return { ...state, lastOpened: id, lessons: { ...state.lessons, [id]: { ...(state.lessons[id] ?? emptyLesson()), opened: true } } };
}

export function toggleBookmark(state: ProgressState, id: string): ProgressState {
  const current = state.lessons[id] ?? emptyLesson();
  return { ...state, lessons: { ...state.lessons, [id]: { ...current, bookmarked: !current.bookmarked } } };
}

export function toggleCompleted(state: ProgressState, id: string): ProgressState {
  const current = state.lessons[id] ?? emptyLesson();
  return { ...state, lessons: { ...state.lessons, [id]: { ...current, opened: true, completed: !current.completed } } };
}

export function completionPercent(state: ProgressState, total: number) {
  if (!total) return 0;
  return Math.round(Object.values(state.lessons).filter(item => item.completed).length / total * 100);
}
