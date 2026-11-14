export default {
  refreshPromise: null,

  onOpen(event) {
    event.waitUntil(this.ensureRefreshed());
  },

  ensureRefreshed() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  },

  async refresh() {
    this.latestStatus = 'ready';
  },
};
