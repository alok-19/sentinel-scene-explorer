import { useCallback, useEffect, useRef, useState } from 'react';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const STAC_SEARCH_URL = 'https://earth-search.aws.element84.com/v1/search';
const STAC_ITEM_URL = 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items';
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_QUERY = 'Tokyo Japan';
const DEFAULT_CLOUD_LIMIT = 20;
const RESULT_LIMIT = 20;

interface NominatimLocation {
  display_name: string;
  boundingbox: [string, string, string, string];
}

interface StacAsset {
  href: string;
  title?: string;
  type?: string;
  roles?: string[];
}

interface StacItemProperties {
  datetime: string;
  ['eo:cloud_cover']?: number;
}

interface StacItem {
  id: string;
  bbox: [number, number, number, number];
  properties: StacItemProperties;
  assets: Record<string, StacAsset | undefined>;
}

interface StacSearchResponse {
  features: StacItem[];
}

interface SceneStats {
  totalScenes: number;
  averageCloudCover: number;
  dateRange: string;
}

interface SearchSummary {
  query: string;
  locationLabel: string;
  bbox: [number, number, number, number];
}

interface SceneAssetSelection {
  previewUrl: string | null;
  dataUrl: string | null;
}

// Abort slow requests so the UI fails fast instead of hanging on public APIs.
async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Request timed out after 10 seconds. Please try again.');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getResponseErrorMessage(serviceName: string, response: Response) {
  if (response.status === 429) {
    return `${serviceName} is rate-limiting requests right now. Wait a moment and try again.`;
  }

  if (response.status >= 500) {
    return `${serviceName} is temporarily unavailable. Please try again shortly.`;
  }

  return `${serviceName} failed with status ${response.status}.`;
}

// Convert a free-form place name into a bounding box using Nominatim.
async function geocodeLocation(query: string): Promise<NominatimLocation> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(getResponseErrorMessage('Geocoding', response));
  }

  const results = (await response.json()) as NominatimLocation[];

  if (!results.length) {
    throw new Error('No matching location was found. Try a broader place name.');
  }

  return results[0];
}

// Query the Earth Search STAC API for recent Sentinel-2 scenes in the selected box.
async function searchScenes(
  bbox: [number, number, number, number],
  cloudCoverLimit: number,
): Promise<StacItem[]> {
  const today = new Date();
  const ninetyDaysAgo = new Date(today);
  ninetyDaysAgo.setDate(today.getDate() - 90);

  const body = {
    collections: ['sentinel-2-l2a'],
    bbox,
    datetime: `${ninetyDaysAgo.toISOString()}/${today.toISOString()}`,
    query: {
      'eo:cloud_cover': {
        lt: cloudCoverLimit,
      },
    },
    limit: RESULT_LIMIT,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };

  const response = await fetchWithTimeout(STAC_SEARCH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(getResponseErrorMessage('Scene search', response));
  }

  const data = (await response.json()) as StacSearchResponse;
  return Array.isArray(data.features) ? data.features : [];
}

function buildBoundingBox(location: NominatimLocation): [number, number, number, number] {
  const [south, north, west, east] = location.boundingbox.map(Number);

  if ([south, north, west, east].some((value) => Number.isNaN(value))) {
    throw new Error('The geocoding response returned an invalid bounding box.');
  }

  return [west, south, east, north];
}

function formatDate(isoDate: string) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(isoDate));
}

function formatDateTime(isoDate: string) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(isoDate));
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
}

function getAssetEntries(item: StacItem) {
  return Object.entries(item.assets).filter((entry): entry is [string, StacAsset] => Boolean(entry[1]?.href));
}

function scorePreviewAsset(assetKey: string, asset: StacAsset) {
  const loweredKey = assetKey.toLowerCase();
  const loweredType = asset.type?.toLowerCase() ?? '';
  const roles = asset.roles?.map((role) => role.toLowerCase()) ?? [];

  if (loweredKey === 'thumbnail') return 100;
  if (loweredKey === 'overview') return 90;
  if (roles.includes('thumbnail')) return 80;
  if (loweredType.startsWith('image/')) return 70;
  if (loweredKey.includes('preview') || loweredKey.includes('visual')) return 60;

  return 0;
}

function scoreDataAsset(assetKey: string, asset: StacAsset) {
  const loweredKey = assetKey.toLowerCase();
  const loweredType = asset.type?.toLowerCase() ?? '';
  const href = asset.href.toLowerCase();
  const roles = asset.roles?.map((role) => role.toLowerCase()) ?? [];

  if (loweredType.includes('geotiff') || loweredType.includes('tiff')) return 100;
  if (href.endsWith('.tif') || href.endsWith('.tiff')) return 90;
  if (roles.includes('data')) return 80;
  if (['visual', 'red', 'green', 'blue', 'nir', 'nir08', 'b04', 'b03', 'b02', 'b08'].includes(loweredKey)) return 70;

  return 0;
}

// Pick the most useful preview image and direct raster asset from each STAC item.
function selectSceneAssets(item: StacItem): SceneAssetSelection {
  const assetEntries = getAssetEntries(item);
  const previewCandidate = [...assetEntries].sort(
    ([firstKey, firstAsset], [secondKey, secondAsset]) =>
      scorePreviewAsset(secondKey, secondAsset) - scorePreviewAsset(firstKey, firstAsset),
  )[0];
  const dataCandidate = [...assetEntries].sort(
    ([firstKey, firstAsset], [secondKey, secondAsset]) =>
      scoreDataAsset(secondKey, secondAsset) - scoreDataAsset(firstKey, firstAsset),
  )[0];

  return {
    previewUrl: previewCandidate && scorePreviewAsset(previewCandidate[0], previewCandidate[1]) > 0 ? previewCandidate[1].href : null,
    dataUrl: dataCandidate && scoreDataAsset(dataCandidate[0], dataCandidate[1]) > 0 ? dataCandidate[1].href : null,
  };
}

function computeSceneStats(items: StacItem[]): SceneStats {
  if (!items.length) {
    return {
      totalScenes: 0,
      averageCloudCover: 0,
      dateRange: 'No scenes',
    };
  }

  const dates = items
    .map((item) => new Date(item.properties.datetime).getTime())
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right);
  const cloudValues = items.map((item) => item.properties['eo:cloud_cover'] ?? 0);
  const averageCloudCover = cloudValues.reduce((sum, value) => sum + value, 0) / cloudValues.length;

  return {
    totalScenes: items.length,
    averageCloudCover,
    dateRange:
      dates.length > 0
        ? `${formatDate(new Date(dates[0]).toISOString())} - ${formatDate(new Date(dates[dates.length - 1]).toISOString())}`
        : 'Unknown',
  };
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-14" role="status" aria-label="Loading scenes">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-cyan/30 border-t-cyan" />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-slate-950/70 p-4">
      <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
    </div>
  );
}

function EmptyState({ hasSearched }: { hasSearched: boolean }) {
  return (
    <section className="mt-6 rounded-3xl border border-dashed border-white/10 bg-slate-950/40 p-10 text-center text-slate-300">
      <h2 className="text-xl font-semibold text-white">{hasSearched ? 'No scenes matched this search' : 'Search for recent scenes'}</h2>
      <p className="mt-3 text-sm leading-6 text-slate-400">
        {hasSearched
          ? 'Try broadening the location or increasing the cloud cover limit to surface more results.'
          : 'Enter a location and choose a cloud cover threshold to start exploring recent Sentinel-2 scenes.'}
      </p>
    </section>
  );
}

function App() {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [cloudCoverLimit, setCloudCoverLimit] = useState(DEFAULT_CLOUD_LIMIT);
  const [items, setItems] = useState<StacItem[]>([]);
  const [stats, setStats] = useState<SceneStats>(computeSceneStats([]));
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const latestRequestIdRef = useRef(0);

  // Run geocoding and scene search as one guarded request so stale responses never overwrite fresh ones.
  const runSearch = useCallback(async (searchQuery: string, nextCloudCoverLimit: number) => {
    const trimmedQuery = searchQuery.trim();

    if (!trimmedQuery) {
      setError('Enter a location name to search for scenes.');
      setItems([]);
      setStats(computeSceneStats([]));
      setSummary(null);
      setHasSearched(false);
      return;
    }

    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;

    setIsLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const location = await geocodeLocation(trimmedQuery);
      const bbox = buildBoundingBox(location);
      const nextItems = await searchScenes(bbox, nextCloudCoverLimit);

      if (latestRequestIdRef.current !== requestId) {
        return;
      }

      setItems(nextItems);
      setStats(computeSceneStats(nextItems));
      setSummary({
        query: trimmedQuery,
        locationLabel: location.display_name,
        bbox,
      });

      if (!nextItems.length) {
        setError('No scenes matched this location and cloud cover threshold in the last 90 days.');
      }
    } catch (caughtError) {
      if (latestRequestIdRef.current !== requestId) {
        return;
      }

      setItems([]);
      setStats(computeSceneStats([]));
      setSummary(null);
      setError(caughtError instanceof Error ? caughtError.message : 'Something went wrong while fetching scenes.');
    } finally {
      if (latestRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void runSearch(DEFAULT_QUERY, DEFAULT_CLOUD_LIMIT);
  }, [runSearch]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await runSearch(query, cloudCoverLimit);
    },
    [cloudCoverLimit, query, runSearch],
  );

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="rounded-3xl border border-cyan/20 bg-slate-950/60 p-6 shadow-cyan backdrop-blur sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <p className="text-sm uppercase tracking-[0.3em] text-cyan">Sentinel Scene Explorer</p>
              <div>
                <h1 className="text-3xl font-semibold text-white sm:text-4xl">Recent Sentinel-2 scenes by location</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
                  Search any place name, geocode it in the browser, and inspect recent low-cloud Sentinel-2 L2A scenes
                  from the Element84 STAC API.
                </p>
              </div>
            </div>

            <form className="grid gap-4 lg:min-w-[420px]" onSubmit={handleSubmit} aria-label="Scene search form">
              <label className="grid gap-2" htmlFor="location-query">
                <span className="text-sm font-medium text-slate-200">Location</span>
                <input
                  id="location-query"
                  className="w-full rounded-2xl border border-cyan/20 bg-slate-900/80 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-cyan focus:ring-2 focus:ring-cyan/20"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Tokyo Japan"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>

              <label className="grid gap-2" htmlFor="cloud-cover-limit">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-200">Max cloud cover</span>
                  <span className="text-cyan">{cloudCoverLimit}%</span>
                </div>
                <input
                  id="cloud-cover-limit"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={cloudCoverLimit}
                  onChange={(event) => setCloudCoverLimit(Number(event.target.value))}
                  className="h-2 cursor-pointer appearance-none rounded-full bg-slate-800 accent-cyan"
                />
              </label>

              <button
                type="submit"
                disabled={isLoading}
                className="rounded-2xl bg-cyan px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan/90 focus:outline-none focus:ring-2 focus:ring-cyan/30 disabled:cursor-not-allowed disabled:bg-cyan/60"
              >
                {isLoading ? 'Searching...' : 'Search'}
              </button>
            </form>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-3" aria-label="Scene summary statistics">
          <StatCard label="Total scenes" value={stats.totalScenes} />
          <StatCard label="Average cloud cover" value={`${formatNumber(stats.averageCloudCover)}%`} />
          <StatCard label="Date range" value={stats.dateRange} />
        </section>

        {summary && (
          <section className="mt-6 rounded-2xl border border-white/8 bg-slate-950/60 p-4 text-sm text-slate-300">
            <p className="font-medium text-white">{summary.locationLabel}</p>
            <p className="mt-1">Search: {summary.query}</p>
            <p className="mt-1">BBOX: [{summary.bbox.map((value) => formatNumber(value)).join(', ')}]</p>
          </section>
        )}

        {error && (
          <section
            className="mt-6 rounded-2xl border border-rose-400/30 bg-rose-950/20 p-4 text-sm text-rose-200"
            role="alert"
          >
            {error}
          </section>
        )}

        {isLoading ? (
          <Spinner />
        ) : items.length ? (
          <section className="mt-6 grid gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="Scene results">
            {items.map((item) => {
              const sceneAssets = selectSceneAssets(item);

              return (
                <article
                  key={item.id}
                  className="overflow-hidden rounded-3xl border border-white/8 bg-slate-950/70 shadow-2xl shadow-black/20"
                >
                  <div className="aspect-[16/9] bg-slate-900">
                    {sceneAssets.previewUrl ? (
                      <img
                        src={sceneAssets.previewUrl}
                        alt={`Preview for scene ${item.id}`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">No preview available</div>
                    )}
                  </div>

                  <div className="space-y-4 p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.25em] text-cyan">Scene ID</p>
                        <h2 className="mt-2 break-all text-lg font-semibold text-white">{item.id}</h2>
                      </div>
                      <div className="rounded-full border border-cyan/25 bg-cyan/10 px-3 py-1 text-sm font-medium text-cyan">
                        {formatNumber(item.properties['eo:cloud_cover'] ?? 0)}%
                      </div>
                    </div>

                    <dl className="grid gap-3 text-sm text-slate-300">
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-400">Acquired</dt>
                        <dd className="text-right text-white">{formatDateTime(item.properties.datetime)}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-slate-400">BBox</dt>
                        <dd className="text-right text-white">[{item.bbox.map((value) => formatNumber(value)).join(', ')}]</dd>
                      </div>
                    </dl>

                    <div className="flex items-center justify-between gap-3">
                      <a
                        href={`${STAC_ITEM_URL}/${item.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm font-medium text-slate-300 transition hover:text-cyan"
                      >
                        Open STAC item
                      </a>
                      <a
                        href={sceneAssets.dataUrl ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                          sceneAssets.dataUrl
                            ? 'bg-cyan text-slate-950 hover:bg-cyan/90'
                            : 'cursor-not-allowed bg-slate-800 text-slate-500'
                        }`}
                        aria-disabled={!sceneAssets.dataUrl}
                        onClick={(event) => {
                          if (!sceneAssets.dataUrl) {
                            event.preventDefault();
                          }
                        }}
                      >
                        {sceneAssets.dataUrl ? 'Open data asset' : 'No data asset'}
                      </a>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        ) : (
          <EmptyState hasSearched={hasSearched} />
        )}
      </main>
    </div>
  );
}

export default App;
