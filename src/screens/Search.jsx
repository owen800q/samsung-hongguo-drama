import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter, useKeys } from '../router.js';
import { enabledSources, search } from '../sources/index.js';
import { addSearch, clearSearches, getSearches } from '../lib/storage.js';
import { SOURCE_LABEL, errorMessage } from '../lib/format.js';
import { TabRow } from '../components/TabRow.jsx';
import { PosterGrid } from '../components/PosterGrid.jsx';
import { Empty, PosterSkeleton, Spinner } from '../components/Status.jsx';
import { Icon } from '../components/Icon.jsx';
import { focusElement, focusFirst } from '../lib/focus.js';

// Sources also return loosely related series; those are ranked after the title matches,
// results of a looser search (without punctuation, or the first clause) first.
function matchSummary(items) {
  const other = items.filter(x => x.relevance === 2).length;
  if (!other) return '';
  const matched = items.length - other;
  const fuzzy = items.filter(x => x.relevance === 2 && x.fuzzy).length;
  const rest = (fuzzy ? fuzzy + ' 部补搜结果' : '') + (fuzzy && other > fuzzy ? '、' : '') + (other > fuzzy ? (other - fuzzy) + ' 部其他结果' : '');
  return matched ? '：' + matched + ' 部标题匹配，另有 ' + rest + '排在后面' : '：没有标题匹配的剧，以下是' + rest;
}

export function Search() {
  const router = useRouter();
  const input = useRef(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [source, setSource] = useState('all');
  // 设置 is another tab, so a changed source switch remounts this screen.
  const [sourceItems] = useState(() => [{ value: 'all', label: '全部来源' }].concat(enabledSources().map(s => ({ value: s.id, label: s.label }))));
  const [recent, setRecent] = useState(getSearches);
  const [state, setState] = useState({ keyword: '', items: [], page: 0, hasMore: false, more: [], loading: false, error: '', notes: [] });
  const request = useRef(0);

  function run(keyword, page, only) {
    const kw = String(keyword || '').trim();
    if (!kw) return;
    const id = ++request.current;
    if (page === 1) {
      addSearch(kw);
      setRecent(getSearches());
    }
    setState(s => Object.assign({}, s, { keyword: kw, loading: true, error: '' }, page === 1 ? { items: [], page: 0, hasMore: false, more: [], notes: [] } : null));
    search(kw, { source, page, only }).then(res => {
      if (id !== request.current) return;
      const failed = (res && res.errors || []).map(e => (SOURCE_LABEL[e.source] || e.source) + '：' + e.error);
      const notes = failed.length ? ['部分来源失败：' + failed.join('；')] : [];
      if (res && res.relaxed && res.relaxed.length) notes.push('原词没有标题匹配，已补搜“' + res.relaxed.join('”“') + '”');
      if (res && res.partial) notes.push('补充搜索未完成，已显示本次查到的结果');
      if (!res || (!res.success && !(res.results || []).length)) throw new Error((res && res.error) || failed.join('；') || '搜索失败');
      setState(s => {
        const seen = new Set(page === 1 ? [] : s.items.map(x => x.series_id));
        const fresh = (res.results || []).filter(x => !seen.has(x.series_id));
        // A later page keeps the first page's notes: they describe the search, not the page.
        return { keyword: kw, items: page === 1 ? fresh : s.items.concat(fresh), page, hasMore: !!res.hasMore && fresh.length > 0,
          more: res.more || [], loading: false, error: '', notes: page === 1 ? notes : s.notes.concat(notes.filter(n => s.notes.indexOf(n) < 0)) };
      });
      if (page === 1 && (res.results || []).length) setTimeout(() => focusFirst('.screen.is-active .poster'), 50);
    }).catch(error => {
      if (id !== request.current) return;
      setState(s => Object.assign({}, s, { loading: false, error: errorMessage(error, '搜索失败') }));
    });
  }

  useEffect(() => { if (state.keyword) run(state.keyword, 1); }, [source]);

  // Tizen shows the on-screen keyboard whenever an editable input gains focus, so the
  // field stays read-only while the user navigates past it and unlocks on OK.
  function startEditing() {
    const el = input.current;
    if (!el) return;
    setEditing(true);
    el.readOnly = false;
    el.blur();
    setTimeout(() => { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch (_) {} }, 0);
  }

  function stopEditing(submit) {
    const el = input.current;
    setEditing(false);
    if (el) el.readOnly = true;
    if (submit) run(el ? el.value : text, 1);
    if (el) focusElement(el);
  }

  useKeys((action, e) => {
    if (e.target !== input.current) return false;
    if (!editing) {
      if (action === 'enter') { startEditing(); return true; }
      return false;
    }
    if (action === 'enter' || action === 'imedone') { stopEditing(true); return true; }
    if (action === 'back' || action === 'imecancel') { stopEditing(false); return true; }
    if (action === 'up' || action === 'down') { stopEditing(false); return false; }
    return false;
  });

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header">
        <h1 class="page-title">搜索</h1>
      </header>
      <div class={'search-field' + (editing ? ' is-editing' : '')}>
        <Icon name="search" />
        <input ref={input} type="search" class="search-input focusable" tabIndex={-1} readOnly data-autofocus
          placeholder="输入剧名，按确认键开始输入" value={text} onInput={e => setText(e.target.value)}
          onClick={() => !editing && startEditing()}
          onBlur={() => { if (editing) { setEditing(false); if (input.current) input.current.readOnly = true; } }}
          autocomplete="off" autocorrect="off" spellcheck={false} enterkeyhint="search" aria-label="搜索剧名" />
        <button type="button" tabIndex={-1} class="btn btn-primary focusable" onClick={() => run(text, 1)}>搜索</button>
      </div>
      <TabRow label="搜索来源" group="search-source" items={sourceItems} value={source} onChange={setSource} />
      {!state.keyword && recent.length > 0 && (
        <section class="recent">
          <div class="section-head">
            <h2 class="section-title">最近搜索</h2>
            <button type="button" tabIndex={-1} class="btn btn-ghost btn-sm focusable" onClick={() => { clearSearches(); setRecent([]); focusElement(input.current); }}>
              <Icon name="trash" />清空
            </button>
          </div>
          <div class="chip-wrap" data-focus-group="search-recent">
            {recent.map(kw => (
              <button key={kw} type="button" tabIndex={-1} class="chip focusable" onClick={() => { setText(kw); run(kw, 1); }}>{kw}</button>
            ))}
          </div>
        </section>
      )}
      {!state.keyword && recent.length === 0 && (
        <p class="hint">按遥控器确认键唤出键盘输入剧名；也可以直接输入红果剧集 ID。</p>
      )}
      <section class="page-body">
        {state.keyword && !state.loading && state.items.length > 0 && (
          <div class="result-head">“{state.keyword}” 的搜索结果{matchSummary(state.items)}{state.notes.length ? <span class="result-note">（{state.notes.join('；')}）</span> : null}</div>
        )}
        {state.items.length > 0 && (
          <PosterGrid items={state.items} group="search-grid" showSource={source === 'all'}
            onNearEnd={() => { if (state.hasMore && !state.loading) run(state.keyword, state.page + 1, state.more); }}
            onSelect={item => router.push('detail', { series: item })} />
        )}
        {state.loading && state.items.length === 0 && <PosterSkeleton count={6} />}
        {state.loading && state.items.length > 0 && <Spinner label="加载更多…" />}
        {!state.loading && state.error && <Empty title="搜索没有成功" message={state.error}
          onAction={() => state.items.length ? run(state.keyword, state.page + 1, state.more) : run(state.keyword, 1)} />}
        {!state.loading && !state.error && state.keyword && state.items.length === 0 && (
          <Empty title={'没有找到“' + state.keyword + '”'} message="换个关键词，或切换到其他来源试试。" />
        )}
      </section>
    </div>
  );
}
