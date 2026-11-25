import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNav, type Route } from './router';

const names = () => useNav.getState().stack.map((e) => e.route.name);
const here = () => useNav.getState().stack[useNav.getState().index];

beforeEach(() => {
  useNav.setState({ stack: [{ key: 1000, route: { name: 'home' } }], index: 0 });
});

describe('goTab', () => {
  it('returns to the tab’s existing screen instead of adding a copy', () => {
    const nav = useNav.getState();
    const home = here().key;
    nav.goTab({ name: 'discover' });
    const discover = here().key;
    nav.goTab({ name: 'home' });
    expect(here().key).toBe(home);
    nav.goTab({ name: 'discover' });
    expect(here().key).toBe(discover);
    nav.goTab({ name: 'home' });
    // Two tabs, however many hops.
    expect(names()).toEqual(['discover', 'home']);
  });

  it('keeps Back pointing at where the user just was', () => {
    const nav = useNav.getState();
    nav.push({ name: 'title', type: 'movie', id: 'tt1' });
    nav.goTab({ name: 'home' });
    expect(names()).toEqual(['title', 'home']);
    nav.back();
    expect(here().route).toEqual({ name: 'title', type: 'movie', id: 'tt1' });
  });

  it('comes back to the tab as it was left (its parameters stay)', () => {
    const nav = useNav.getState();
    nav.goTab({ name: 'settings' });
    nav.replace({ name: 'settings', section: 'home' });
    const settings = here().key;
    nav.goTab({ name: 'home' });
    nav.goTab({ name: 'settings' });
    expect(here()).toEqual({ key: settings, route: { name: 'settings', section: 'home' } });
  });

  it('drops forward history like any other navigation', () => {
    const nav = useNav.getState();
    nav.goTab({ name: 'search' });
    nav.push({ name: 'title', type: 'movie', id: 'tt1' });
    nav.back();
    nav.back();
    expect(here().route.name).toBe('home');
    nav.goTab({ name: 'search' });
    expect(names()).toEqual(['home', 'search']);
  });

  it('scrolls to the top when the tab is already showing', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    useNav.getState().goTab({ name: 'home' });
    expect(names()).toEqual(['home']);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe('rove:scroll-top');
    vi.unstubAllGlobals();
  });
});

describe('drop', () => {
  const ofCollection = (id: string) => (r: Route) => (r.name === 'collection' || r.name === 'collection-edit') && r.id === id;

  it('removes a deleted collection’s pages and lands on the page before them', () => {
    const nav = useNav.getState();
    nav.push({ name: 'library', tab: 'collections' });
    nav.push({ name: 'collection', id: 'c1' });
    nav.push({ name: 'collection-edit', id: 'c1' });
    nav.drop(ofCollection('c1'));
    expect(names()).toEqual(['home', 'library']);
    expect(here().route.name).toBe('library');
  });

  it('leaves other pages and the current page alone', () => {
    const nav = useNav.getState();
    nav.push({ name: 'collection', id: 'c1' });
    nav.push({ name: 'collection', id: 'c2' });
    nav.drop(ofCollection('c1'));
    expect(here().route).toEqual({ name: 'collection', id: 'c2' });
    expect(names()).toEqual(['home', 'collection']);
  });

  it('falls back to Home when nothing else is left', () => {
    useNav.setState({ stack: [{ key: 5, route: { name: 'collection', id: 'c1' } }], index: 0 });
    useNav.getState().drop(ofCollection('c1'));
    expect(names()).toEqual(['home']);
    expect(useNav.getState().index).toBe(0);
  });
});
