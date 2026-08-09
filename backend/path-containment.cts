const path = require('path');

/** Lexical same-or-descendant check. Strict-descendant callers must also
 * reject an empty path.relative result. */
function isSameOrDescendantPath(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export { isSameOrDescendantPath };
