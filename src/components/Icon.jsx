// Inline stroke icons sized by CSS (1em). Kept minimal: only what the TV UI uses.
const PATHS = {
  compass: <g><circle cx="12" cy="12" r="9" /><path d="M15.5 8.5l-2 5-5 2 2-5z" /></g>,
  search: <g><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></g>,
  clock: <g><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></g>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  heartFill: <path fill="currentColor" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  gear: <g><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></g>,
  play: <path fill="currentColor" stroke="none" d="M8 5.5v13l10.5-6.5z" />,
  pause: <g fill="currentColor" stroke="none"><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></g>,
  next: <g fill="currentColor" stroke="none"><path d="M6 5.5v13l9-6.5z" /><rect x="16" y="5.5" width="2.5" height="13" rx="1" /></g>,
  prev: <g fill="currentColor" stroke="none"><path d="M18 5.5v13l-9-6.5z" /><rect x="5.5" y="5.5" width="2.5" height="13" rx="1" /></g>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  speed: <g><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /></g>,
  refresh: <g><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4.5h-4.5" /></g>,
  lock: <g><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></g>,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />,
  back: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  fire: <path d="M12 21c-4 0-6.5-2.7-6.5-6.2C5.5 10 10 8.5 10 3.5c3 1.7 4.5 4.5 4 7 1-.5 1.8-1.5 2-2.8 1.6 1.6 2.5 3.8 2.5 6.6 0 3.9-2.6 6.7-6.5 6.7z" />,
};

export function Icon({ name, class: cls }) {
  return (
    <svg class={'icon' + (cls ? ' ' + cls : '')} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
