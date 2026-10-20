'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { lessons, tracks } from './content/generated';
import { Markdown } from './lib/markdown';
import { completionPercent, EMPTY_PROGRESS, loadProgress, STORAGE_KEY, toggleBookmark, toggleCompleted, touchLesson, type ProgressState } from './lib/progress';

type TrackId = typeof tracks[number]['id'];
type Lesson = typeof lessons[number];
type Theme = 'light' | 'dark';

const THEME_KEY = 'sql-mastery-theme';

function useTheme() {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = localStorage.getItem(THEME_KEY);
      const initial: Theme = stored === 'light' || stored === 'dark' ? stored : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      setTheme(initial);
      document.documentElement.dataset.theme = initial;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const toggle = () => setTheme(current => {
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    return next;
  });
  return { theme, toggle };
}

function useRoute() {
  const [route, setRoute] = useState('/');
  useEffect(() => { const sync = () => setRoute(new URLSearchParams(location.search).get('route') ?? '/'); sync(); addEventListener('popstate', sync); return () => removeEventListener('popstate', sync); }, []);
  const navigate = (next: string) => { const url = new URL(location.href); if (next === '/') url.searchParams.delete('route'); else url.searchParams.set('route', next); url.hash = ''; history.pushState({}, '', url); setRoute(next); scrollTo({ top: 0, behavior: 'smooth' }); };
  return { route, navigate };
}

function useProgress() {
  const [progress, setProgress] = useState<ProgressState>(EMPTY_PROGRESS);
  const [ready, setReady] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => { setProgress(loadProgress(localStorage.getItem(STORAGE_KEY))); setReady(true); }, 0); return () => window.clearTimeout(timer); }, []);
  const save = useCallback((next: ProgressState) => { setProgress(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }, []);
  return { progress, save, ready };
}

function Header({ navigate, progress, theme, toggleTheme }: { navigate: (route: string) => void; progress: ProgressState; theme: Theme; toggleTheme: () => void }) {
  const percent = completionPercent(progress, lessons.length);
  return <header className="site-header">
    <button className="brand" onClick={() => navigate('/')}><span className="brand-icon">S<span>Q</span>L</span><span><strong>SQL Mastery</strong><small>PostgreSQL field notes</small></span></button>
    <nav aria-label="Main navigation"><button onClick={() => navigate('/')}>Curriculum</button><button onClick={() => navigate('/review')}>Review lab</button><button onClick={() => navigate('/reference')}>SQL order</button><Link href="/vector-databases/">Vector report</Link><Link href="/graph-databases/">Graph report</Link><Link href="/llm-wiki/">Wiki report</Link></nav>
    <div className="header-tools"><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}><span aria-hidden="true">{theme === 'light' ? '◐' : '☀'}</span><small>{theme === 'light' ? 'Dark' : 'Light'}</small></button><button className="progress-chip" onClick={() => navigate('/progress')}><span>{percent}%</span><i><b style={{ width: `${percent}%` }} /></i><small>Progress</small></button></div>
  </header>;
}

function Dashboard({ navigate, progress }: { navigate: (route: string) => void; progress: ProgressState }) {
  const [query, setQuery] = useState('');
  const [track, setTrack] = useState<'all' | TrackId>('all');
  const [status, setStatus] = useState<'all' | 'open' | 'complete' | 'saved'>('all');
  const filtered = useMemo(() => lessons.filter(lesson => {
    const p = progress.lessons[lesson.id];
    const haystack = `${lesson.title} ${lesson.summary} ${lesson.sectionTitles.join(' ')}`.toLowerCase();
    return (track === 'all' || lesson.trackId === track) && (!query || haystack.includes(query.toLowerCase())) && (status === 'all' || (status === 'open' && !p?.completed) || (status === 'complete' && p?.completed) || (status === 'saved' && p?.bookmarked));
  }), [progress, query, status, track]);
  const last = lessons.find(lesson => lesson.id === progress.lastOpened) ?? lessons[0];
  const completed = Object.values(progress.lessons).filter(item => item.completed).length;
  const totalMinutes = lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
  return <main id="main-content">
    <section className="hero">
      <div className="hero-copy"><p className="eyebrow">PostgreSQL · Node.js · Production</p><h1>Learn the database<br/><em>beneath the syntax.</em></h1><p>Move from relationship fundamentals to query plans, concurrency, resilient architecture, and the interview room.</p><div className="hero-actions"><button className="button primary" onClick={() => navigate(`/lesson/${last.id}`)}>{progress.lastOpened ? 'Continue learning' : 'Start the path'} <span>↗</span></button><button className="text-button" onClick={() => document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' })}>Explore curriculum ↓</button></div></div>
      <div className="query-window" aria-label="SQL example"><div><span></span><span></span><span></span><small>query.sql</small></div><pre><code><b>SELECT</b>{'\n  '}skill, <i>depth</i>{'\n'}<b>FROM</b> sql_mastery{'\n'}<b>WHERE</b> curiosity = <em>true</em>{'\n'}<b>ORDER BY</b> practice <b>DESC</b>;</code></pre><div className="query-result"><span>4 tracks</span><span>{lessons.length} lessons</span><span>{Math.round(totalMinutes / 60)}h deep work</span></div></div>
    </section>
    <section className="signal-strip"><span>01</span><p><strong>Model it.</strong> Put every fact in the right place.</p><span>02</span><p><strong>Measure it.</strong> Read what the planner actually did.</p><span>03</span><p><strong>Protect it.</strong> Make invariants survive every writer.</p></section>
    <section className="tracks-section">
      <div className="section-intro"><div><p className="eyebrow">Four connected tracks</p><h2>From clean tables<br/>to reliable systems.</h2></div><p>Follow the sequence or jump directly to the production problem in front of you. Every lesson keeps its runnable SQL close at hand.</p></div>
      <div className="track-grid">{tracks.map((item, index) => { const count = lessons.filter(lesson => lesson.trackId === item.id).length; const done = lessons.filter(lesson => lesson.trackId === item.id && progress.lessons[lesson.id]?.completed).length; return <button className={`track-card ${item.color}`} key={item.id} onClick={() => { setTrack(item.id); document.getElementById('library')?.scrollIntoView({ behavior: 'smooth' }); }}><span className="track-number">0{index + 1}</span><small>{item.eyebrow}</small><h3>{item.name}</h3><p>{item.description}</p><div><span>{count} lessons</span><span>{done}/{count} complete ↗</span></div></button>; })}</div>
    </section>
    <section className="library" id="library">
      <div className="library-head"><div><p className="eyebrow">The knowledge base</p><h2>Choose your next lesson.</h2></div><label className="search"><span>⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search indexes, RLS, pooling…" aria-label="Search lessons" /></label></div>
      <div className="filters"><select value={track} onChange={event => setTrack(event.target.value as typeof track)}><option value="all">All tracks</option>{tracks.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="all">Any status</option><option value="open">Not completed</option><option value="complete">Completed</option><option value="saved">Bookmarked</option></select><button onClick={() => { setQuery(''); setTrack('all'); setStatus('all'); }}>Reset filters</button><span>{filtered.length} lessons</span></div>
      <div className="lesson-grid">{filtered.map(lesson => <LessonCard key={lesson.id} lesson={lesson} navigate={navigate} progress={progress} />)}</div>
      {!filtered.length && <div className="empty"><strong>No matching lesson.</strong><p>Try a broader term or reset the filters.</p></div>}
    </section>
    <section className="dashboard-cta"><div><p className="eyebrow">Your local learning record</p><h2>{completed ? `${completed} lessons down. Keep the chain alive.` : 'Your progress stays in your browser.'}</h2></div><button className="button light" onClick={() => navigate('/progress')}>Open progress report →</button></section>
  </main>;
}

function LessonCard({ lesson, navigate, progress }: { lesson: Lesson; navigate: (route: string) => void; progress: ProgressState }) {
  const track = tracks.find(item => item.id === lesson.trackId)!; const p = progress.lessons[lesson.id];
  return <article className={`lesson-card ${track.color}`}><div className="lesson-meta"><span>{track.name}</span><span>{lesson.minutes} min</span></div><h3>{lesson.title}</h3><p>{lesson.summary}</p><div className="lesson-stats"><span>{lesson.sectionTitles.length} concepts</span><span>{lesson.codeBlocks} code blocks</span></div><div className="lesson-foot"><span>{p?.completed ? '✓ Completed' : p?.opened ? 'In progress' : `Lesson ${String(lesson.order).padStart(2, '0')}`}</span><button onClick={() => navigate(`/lesson/${lesson.id}`)} aria-label={`Open ${lesson.title}`}>→</button></div></article>;
}

function LessonPage({ lesson, navigate, progress, save, ready }: { lesson: Lesson; navigate: (route: string) => void; progress: ProgressState; save: (state: ProgressState) => void; ready: boolean }) {
  const [copied, setCopied] = useState(''); const current = progress.lessons[lesson.id]; const track = tracks.find(item => item.id === lesson.trackId)!;
  useEffect(() => { if (ready && progress.lastOpened !== lesson.id) save(touchLesson(progress, lesson.id)); }, [lesson.id, progress, ready, save]);
  const onCopy = async (code: string) => { try { await navigator.clipboard.writeText(code); setCopied('Copied to clipboard'); setTimeout(() => setCopied(''), 1600); } catch { setCopied('Select the code and copy it manually'); } };
  const sameTrack = lessons.filter(item => item.trackId === lesson.trackId); const position = sameTrack.findIndex(item => item.id === lesson.id); const previous = sameTrack[position - 1]; const next = sameTrack[position + 1];
  return <main id="main-content" className="lesson-page">
    <div className="breadcrumb"><button onClick={() => navigate('/')}>Curriculum</button><span>/</span><button onClick={() => navigate('/')}>{track.name}</button><span>/</span><span>{String(lesson.order).padStart(2, '0')}</span></div>
    <section className={`lesson-hero ${track.color}`}><div><p className="eyebrow">{track.eyebrow} · {lesson.minutes} min read</p><h1>{lesson.title}</h1><p>{lesson.summary}</p><div className="lesson-buttons"><button className={`save-button ${current?.bookmarked ? 'active' : ''}`} onClick={() => save(toggleBookmark(progress, lesson.id))}>{current?.bookmarked ? '★ Saved' : '☆ Save lesson'}</button><button className={`complete-button ${current?.completed ? 'active' : ''}`} onClick={() => save(toggleCompleted(progress, lesson.id))}>{current?.completed ? '✓ Completed' : 'Mark complete'}</button></div></div><aside><span>Lesson map</span><ol>{lesson.sectionTitles.slice(0, 8).map((title, index) => <li key={`${title}-${index}`}><a href={`#${title.toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}>{title}</a></li>)}</ol></aside></section>
    <div className="reading-layout"><article className="prose"><Markdown source={lesson.markdown.replace(/^#\s+.+\n+/, '')} onCopy={onCopy} /></article><aside className="reading-rail"><div><small>Reading progress</small><strong>{current?.completed ? 'Complete' : current?.opened ? 'In progress' : 'New'}</strong></div><div><small>Source coverage</small><strong>{lesson.sectionTitles.length} concepts</strong><span>{lesson.codeBlocks} runnable examples</span></div><button onClick={() => navigate('/review')}>Practice key ideas →</button></aside></div>
    <nav className="lesson-nav">{previous ? <button onClick={() => navigate(`/lesson/${previous.id}`)}><small>Previous</small><strong>← {previous.title}</strong></button> : <span />}{next ? <button onClick={() => navigate(`/lesson/${next.id}`)}><small>Next</small><strong>{next.title} →</strong></button> : <button onClick={() => navigate('/')}><small>Track complete</small><strong>Back to curriculum →</strong></button>}</nav>
    <div className={`toast ${copied ? 'show' : ''}`} role="status">{copied}</div>
  </main>;
}

function ReviewLab({ navigate, progress }: { navigate: (route: string) => void; progress: ProgressState }) {
  const candidates = lessons.filter(lesson => progress.lessons[lesson.id]?.opened || progress.lessons[lesson.id]?.bookmarked); const pool = candidates.length ? candidates : lessons.slice(0, 8);
  const [index, setIndex] = useState(0); const [revealed, setRevealed] = useState(false); const lesson = pool[index % pool.length]; const concepts = lesson.sectionTitles.filter(title => !/table of contents/i.test(title)); const prompt = concepts[0] ?? lesson.title;
  const next = () => { setIndex(value => (value + 1) % pool.length); setRevealed(false); };
  return <main id="main-content" className="review-page"><section className="review-hero"><p className="eyebrow">Active recall</p><h1>Review the idea.<br/><em>Then reveal the map.</em></h1><p>Cards come from lessons you have opened or saved. Explain the concept aloud before checking the lesson structure.</p></section><div className="review-layout"><div className={`flash-card ${revealed ? 'revealed' : ''}`}><div className="flash-top"><span>{tracks.find(item => item.id === lesson.trackId)?.name}</span><span>{index + 1} / {pool.length}</span></div><small>Explain this concept</small><h2>{prompt}</h2>{revealed ? <div className="reveal"><p>Connect your answer to these ideas:</p><ul>{concepts.slice(1, 6).map(item => <li key={item}>{item}</li>)}</ul><button onClick={() => navigate(`/lesson/${lesson.id}`)}>Open full lesson ↗</button></div> : <button className="button primary" onClick={() => setRevealed(true)}>Reveal key ideas</button>}</div><aside><p className="eyebrow">How to use the lab</p><ol><li>Say what the concept solves.</li><li>Name the database mechanism.</li><li>Describe one failure mode.</li><li>Reveal and fill the gaps.</li></ol><button onClick={next}>Next card →</button></aside></div></main>;
}

const sqlOrder = [
  ['01', 'FROM / JOIN', 'Build the source row set.'], ['02', 'WHERE', 'Remove rows before grouping.'], ['03', 'GROUP BY', 'Create groups for aggregation.'], ['04', 'HAVING', 'Remove groups after aggregation.'], ['05', 'SELECT', 'Compute the output expressions.'], ['06', 'DISTINCT', 'Remove duplicate result rows.'], ['07', 'ORDER BY', 'Sort the result.'], ['08', 'LIMIT / OFFSET', 'Return the requested window.'],
];
function ReferencePage({ navigate }: { navigate: (route: string) => void }) {
  const [active, setActive] = useState(0);
  return <main id="main-content" className="reference-page"><section className="reference-hero"><p className="eyebrow">Pocket reference</p><h1>SQL is written<br/><em>in one order,</em><br/>evaluated in another.</h1><p>Select a stage to see what is available to the next one.</p></section><section className="order-lab"><div className="order-list">{sqlOrder.map((item, index) => <button className={active === index ? 'active' : ''} onClick={() => setActive(index)} key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong></button>)}</div><div className="order-detail"><span>Logical step {sqlOrder[active][0]}</span><h2>{sqlOrder[active][1]}</h2><p>{sqlOrder[active][2]}</p><div className="pipeline">{sqlOrder.map((item, index) => <i className={index <= active ? 'active' : ''} key={item[0]} />)}</div><p className="tip">{active < 2 ? 'Tip: shrinking the row set early usually reduces downstream work.' : active === 4 ? 'This is why most SELECT aliases are not available in WHERE.' : 'Remember: logical order describes meaning, while the optimizer can choose a different physical plan.'}</p></div></section><button className="floating-back" onClick={() => navigate('/')}>← Back to curriculum</button></main>;
}

function ProgressPage({ navigate, progress, save }: { navigate: (route: string) => void; progress: ProgressState; save: (state: ProgressState) => void }) {
  const completed = Object.values(progress.lessons).filter(item => item.completed).length; const opened = Object.values(progress.lessons).filter(item => item.opened).length; const saved = Object.values(progress.lessons).filter(item => item.bookmarked).length;
  return <main id="main-content" className="progress-page"><section className="progress-hero"><p className="eyebrow">Your learning record</p><h1>Knowledge compounds<br/><em>one lesson at a time.</em></h1></section><div className="stats"><div><strong>{completionPercent(progress, lessons.length)}%</strong><span>Course complete</span></div><div><strong>{completed}</strong><span>Lessons mastered</span></div><div><strong>{opened}</strong><span>Lessons explored</span></div><div><strong>{saved}</strong><span>Bookmarks</span></div></div><section className="track-progress"><div className="section-intro"><div><p className="eyebrow">Track by track</p><h2>See where to focus.</h2></div></div>{tracks.map(track => { const subset = lessons.filter(lesson => lesson.trackId === track.id); const done = subset.filter(lesson => progress.lessons[lesson.id]?.completed).length; const percent = Math.round(done / subset.length * 100); return <div className="progress-row" key={track.id}><div><strong>{track.name}</strong><span>{done} / {subset.length}</span></div><div><i style={{ width: `${percent}%` }} /></div><b>{percent}%</b></div>; })}</section><section className="progress-actions"><div><h2>Progress is stored only on this device.</h2><p>No account, tracking pixel, or server database is involved.</p></div><button onClick={() => { if (confirm('Clear all lesson progress and bookmarks on this device?')) save(EMPTY_PROGRESS); }}>Reset local progress</button></section><button className="floating-back" onClick={() => navigate('/')}>← Back to curriculum</button></main>;
}

export default function CourseApp() {
  const { route, navigate } = useRoute(); const { progress, save, ready } = useProgress(); const { theme, toggle } = useTheme();
  const lesson = route.startsWith('/lesson/') ? lessons.find(item => item.id === route.slice('/lesson/'.length)) : undefined;
  return <div className="app-shell"><Header navigate={navigate} progress={progress} theme={theme} toggleTheme={toggle} />{lesson ? <LessonPage lesson={lesson} navigate={navigate} progress={progress} save={save} ready={ready} /> : route === '/review' ? <ReviewLab navigate={navigate} progress={progress} /> : route === '/reference' ? <ReferencePage navigate={navigate} /> : route === '/progress' ? <ProgressPage navigate={navigate} progress={progress} save={save} /> : <Dashboard navigate={navigate} progress={progress} />}<footer><strong>SQL Mastery</strong><p>PostgreSQL patterns for systems that have to stay correct.</p><span>{lessons.length} lessons · PostgreSQL 14+</span></footer></div>;
}
