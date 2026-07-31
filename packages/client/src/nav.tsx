/** Tiny hash-based navigation so views are deep-linkable without a router dep. */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type View =
  | { name: 'library' }
  | { name: 'editor'; promptId: string }
  | { name: 'composer'; promptId: string; versionId: string }
  | { name: 'jobs' }
  | { name: 'job'; jobId: string };

interface NavContextValue {
  view: View;
  go: (view: View) => void;
}

const NavContext = createContext<NavContextValue>({
  view: { name: 'library' },
  go: () => {},
});

function parseHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [name, a, b] = hash.split('/');
  switch (name) {
    case 'editor':
      return a ? { name: 'editor', promptId: a } : { name: 'library' };
    case 'composer':
      return a && b
        ? { name: 'composer', promptId: a, versionId: b }
        : { name: 'library' };
    case 'jobs':
      return { name: 'jobs' };
    case 'job':
      return a ? { name: 'job', jobId: a } : { name: 'jobs' };
    default:
      return { name: 'library' };
  }
}

export function viewToHash(view: View): string {
  switch (view.name) {
    case 'editor':
      return `#/editor/${view.promptId}`;
    case 'composer':
      return `#/composer/${view.promptId}/${view.versionId}`;
    case 'jobs':
      return '#/jobs';
    case 'job':
      return `#/job/${view.jobId}`;
    default:
      return '#/';
  }
}

export function NavProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>(() => parseHash());

  useEffect(() => {
    const onHashChange = () => setView(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const go = (next: View) => {
    const target = viewToHash(next);
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    setView(next);
  };

  return <NavContext.Provider value={{ view, go }}>{children}</NavContext.Provider>;
}

export function useNav(): NavContextValue {
  return useContext(NavContext);
}
