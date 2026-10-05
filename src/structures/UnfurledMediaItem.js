'use strict';

class UnfurledMediaItem {
  /**
   * @property {string} [url] Supports arbitrary urls and `attachment://<filename>` references
   */
  /**
   * @param {UnfurledMediaItem | APIUnfurledMediaItem} [data={}] The data
   */
  constructor(data = {}) {
    /**
     * @type {string}
     */
    this.url = data.url ?? null;
    /**
     * @type {APIUnfurledMediaItem}
     */
    this.data = data;
  }
  /**
   * Returns the API-compatible JSON for this media item
   * @returns {APIUnfurledMediaItem}
   */
  toJSON() {
    return { ...this.data, url: this.url };
  }
}

module.exports = UnfurledMediaItem;
