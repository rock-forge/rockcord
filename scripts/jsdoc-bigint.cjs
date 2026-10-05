'use strict';

// JSDoc 4 captures BigInt literal defaults, which its JSON dumper cannot serialize.
exports.handlers = {
  processingComplete({ doclets }) {
    // Internal cache tombstone WeakSets are implementation details, not public API constants.
    for (let i = doclets.length - 1; i >= 0; i--) {
      const doclet = doclets[i];
      if (doclet.kind === 'constant' && doclet.access === 'private' && doclet.comment?.includes('@internal')) {
        doclets.splice(i, 1);
      }
    }
    const seen = new WeakSet();
    const normalize = value => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const key of Object.keys(value)) {
        if (typeof value[key] === 'bigint') value[key] = value[key].toString();
        else normalize(value[key]);
      }
    };
    normalize(doclets);
  },
};
