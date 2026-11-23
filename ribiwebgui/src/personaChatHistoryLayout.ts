/** Wait for one layout frame without retaining a hidden or disposed history view. */
export function waitForChatHistoryFrame(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || document.hidden) return Promise.resolve(false);
  return new Promise(resolve => {
    let frame: number | undefined;
    let settled = false;
    const finish = (visible: boolean) => {
      if (settled) return;
      settled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener("abort", abort);
      document.removeEventListener("visibilitychange", visibilityChanged);
      resolve(visible);
    };
    const abort = () => finish(false);
    const visibilityChanged = () => { if (document.hidden) finish(false); };
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", visibilityChanged);
    frame = requestAnimationFrame(() => finish(!signal.aborted && !document.hidden));
  });
}


/** Every history component uses its own message pane, with a document fallback for standalone views. */
export function chatHistoryScroller(element?: Element | null): HTMLElement {
  return (element?.closest<HTMLElement>('[data-history-scroll]') ?? document.scrollingElement) as HTMLElement;
}

export function chatHistoryViewport(scroller: HTMLElement): { top: number; bottom: number } {
  if (scroller === document.scrollingElement) return { top: 0, bottom: window.innerHeight };
  const bounds = scroller.getBoundingClientRect();
  return { top: bounds.top, bottom: bounds.bottom };
}

/** Read one older page when the reader reaches the top of their message pane. */
export function bindChatHistoryLoadOlder(
  scroller: HTMLElement, load: () => void, scrollTarget: EventTarget = scroller
): () => void {
  const topThreshold = 2;
  let previousTop = scroller.scrollTop;
  const onScroll = () => {
    const top = scroller.scrollTop;
    const reachedTop = top <= topThreshold && previousTop > topThreshold;
    previousTop = top;
    if (reachedTop && scroller.clientHeight > 0) load();
  };
  const onWheel = (event: Event) => {
    if ((event as WheelEvent).deltaY < 0 && scroller.scrollTop <= topThreshold && scroller.clientHeight > 0) load();
  };
  scrollTarget.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('wheel', onWheel, { passive: true });
  return () => {
    scrollTarget.removeEventListener('scroll', onScroll);
    scroller.removeEventListener('wheel', onWheel);
  };
}


/** Keep measured virtual rows at the bottom until the reader scrolls away. */
export function bindChatHistoryScroll(scroller: HTMLElement, content: HTMLElement): { dispose(): void; restorePosition(top: number): void } {
  let followBottom = true;
  let lastScrollTop = scroller.scrollTop;
  let frame = 0;
  const trackPosition = () => {
    if (!scroller.clientHeight) return;
    const top = scroller.scrollTop;
    if (top > lastScrollTop && scroller.scrollHeight - top - scroller.clientHeight <= 1) followBottom = true;
    lastScrollTop = top;
  };
  const interrupt = () => { followBottom = false; lastScrollTop = scroller.scrollTop; };
  const observer = new ResizeObserver(() => {
    if (!followBottom || !scroller.clientHeight) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (followBottom && scroller.clientHeight) scroller.scrollTop = scroller.scrollHeight;
    });
  });
  observer.observe(scroller);
  observer.observe(content);
  scroller.addEventListener('scroll', trackPosition, { passive: true });
  const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
  for (const event of events) scroller.addEventListener(event, interrupt, { passive: true });
  return {
    restorePosition(top: number) {
      followBottom = false;
      cancelAnimationFrame(frame);
      scroller.scrollTop = top;
      lastScrollTop = scroller.scrollTop;
      followBottom = scroller.scrollHeight - lastScrollTop - scroller.clientHeight <= 1;
    },
    dispose() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', trackPosition);
      for (const event of events) scroller.removeEventListener(event, interrupt);
    }
  };
}
