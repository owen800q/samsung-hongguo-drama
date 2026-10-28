import { useEffect, useRef, useState } from 'preact/hooks';
import { useRouter } from '../router.js';
import { browseCategories, browseList, enabledSources } from '../sources/index.js';
import { getSettings } from '../lib/storage.js';
import { errorMessage } from '../lib/format.js';
import { TabRow } from '../components/TabRow.jsx';
import { PosterGrid } from '../components/PosterGrid.jsx';
import { Empty, PosterSkeleton, Spinner } from '../components/Status.jsx';

export function Browse() {
  const router = useRouter();
  // 设置 is another tab, so a changed source switch remounts this screen.
  const [sources] = useState(() => enabledSources());
  const [source, setSource] = useState(() => {
    const preferred = getSettings().defaultSource;
    return sources.some(s => s.id === preferred) ? preferred : 'hongguo';
  });
  const categories = browseCategories(source);
  const [category, setCategory] = useState(categories[0] ? categories[0].slug : '');
  const [genre, setGenre] = useState('');
  const [state, setState] = useState({ items: [], page: 0, hasMore: false, loading: true, error: '', genres: [], empty: '' });
  const request = useRef(0);
  const ranking = (categories.find(c => c.slug === category) || {}).group === 'rank';

  function load(page, force) {
    const id = ++request.current;
    setState(s => Object.assign({}, s, { loading: true, error: page === 1 ? '' : s.error }, page === 1 ? { items: [], page: 0, hasMore: false } : null));
    browseList({ source, category, genre, page, forceRefresh: !!force }).then(res => {
      if (id !== request.current) return;
      if (!res || !res.success) throw new Error((res && res.error) || '目录加载失败');
      setState(s => {
        const seen = new Set(page === 1 ? [] : s.items.map(x => x.series_id));
        const fresh = (res.results || []).filter(x => !seen.has(x.series_id));
        return {
          items: page === 1 ? fresh : s.items.concat(fresh),
          page: res.page || page,
          hasMore: !!res.hasMore && fresh.length > 0,
          loading: false, error: '',
          genres: res.genres && res.genres.length ? res.genres : (page === 1 ? [] : s.genres),
          empty: res.emptyMessage || '',
        };
      });
    }).catch(error => {
      if (id !== request.current) return;
      setState(s => Object.assign({}, s, { loading: false, error: errorMessage(error, '目录加载失败') }));
    });
  }

  useEffect(() => { load(1); }, [source, category, genre]);

  function changeSource(next) {
    if (next === source) return;
    const cats = browseCategories(next);
    setSource(next);
    setCategory(cats[0] ? cats[0].slug : '');
    setGenre('');
  }

  const loadMore = () => {
    if (state.hasMore && !state.loading) load(state.page + 1);
  };

  // When a source's catalog is unreachable (红果 often is), offer the next one straight from the error.
  const next = sources[(sources.findIndex(s => s.id === source) + 1) % sources.length];
  const fallback = next && next.id !== source ? next : null;

  const genreItems = ranking || !state.genres.length ? []
    : [{ value: '', label: source === 'xifan' ? '推荐' : '全部' }].concat(state.genres.map(g => ({ value: g.slug, label: g.label })));

  return (
    <div class="page" data-scroll="y" data-scroll-pad="160">
      <header class="page-header">
        <h1 class="page-title">发现短剧</h1>
        <TabRow label="来源" group="browse-source" size="lg" autofocus
          items={sources.map(s => ({ value: s.id, label: s.label }))} value={source} onChange={changeSource} />
      </header>
      {categories.length > 1 && (
        <TabRow label="分类" group="browse-category" items={categories.map(c => ({ value: c.slug, label: c.label }))}
          value={category} onChange={next => { setCategory(next); setGenre(''); }} />
      )}
      {genreItems.length > 0 && (
        <TabRow label="题材" group="browse-genre" size="sm" items={genreItems} value={genre} onChange={setGenre} />
      )}
      <section class="page-body">
        {state.items.length > 0 && (
          <PosterGrid items={state.items} group="browse-grid" onNearEnd={loadMore}
            onSelect={item => router.push('detail', { series: item })} />
        )}
        {state.loading && state.items.length === 0 && <PosterSkeleton />}
        {state.loading && state.items.length > 0 && <Spinner label="加载更多…" />}
        {!state.loading && state.error && (
          <Empty title="目录暂时加载不了" message={state.error} onAction={() => load(state.items.length ? state.page + 1 : 1, true)}
            {...(fallback && !state.items.length ? { secondaryLabel: '改看' + fallback.label, onSecondary: () => changeSource(fallback.id) } : null)} />
        )}
        {!state.loading && !state.error && state.items.length === 0 && (
          <Empty title="这里还没有内容" message={state.empty || '换个分类或题材看看。'} onAction={() => load(1, true)} actionLabel="刷新" />
        )}
        {!state.loading && !state.error && state.items.length > 0 && !state.hasMore && <div class="list-end">已经到底了</div>}
      </section>
    </div>
  );
}
