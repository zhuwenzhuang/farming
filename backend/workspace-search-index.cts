import * as fsp from 'fs/promises';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

export interface PathMatchRange {
  start: number;
  end: number;
}

export interface WorkspaceSearchIndexedEntry {
  basename: string;
  basenameOffset: number;
  charMaskHi: number;
  charMaskLo: number;
  depth: number;
  entryType: 'directory' | 'file';
  lowerBasename: string;
  lowerPath: string;
  path: string;
  searchIgnored: boolean;
}

export interface WorkspaceSearchMatch {
  entryType: 'directory' | 'file';
  path: string;
  ranges: PathMatchRange[];
  score: number;
}

export interface WorkspaceSearchQueryOptions {
  allowPathMatch?: boolean;
  includeDirectories?: boolean;
  includeFiles?: boolean;
  includeSearchIgnoredDirectories?: boolean;
  limit: number;
  pathPrefix?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface WorkspaceSearchQueryResult {
  cacheHit: boolean;
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
}

export interface WorkspaceSearchIndexOptions {
  excludeGlobArgs: () => string[];
  idleTtlMs?: number;
  isSearchIgnored: (relativePath: string) => boolean;
  maxEntriesPerRoot?: number;
  maxRoots?: number;
  pruneEmptyDirectoryScan?: (relativePath: string) => boolean;
  rgPath: () => string;
  staleTtlMs?: number;
}

interface WorkspaceSearchSnapshot {
  builtAt: number;
  directories: WorkspaceSearchIndexedEntry[];
  files: WorkspaceSearchIndexedEntry[];
  fingerprint: string;
  truncated: boolean;
}

interface ActiveBuild {
  background: boolean;
  child: ChildProcess | null;
  generation: number;
  promise: Promise<WorkspaceSearchSnapshot>;
  waiters: number;
}

interface RootIndexState {
  activeBuild: ActiveBuild | null;
  generation: number;
  lastAccessedAt: number;
  mruPaths: Map<string, number>;
  snapshot: WorkspaceSearchSnapshot | null;
}

interface ParsedQueryToken {
  charMaskHi: number;
  charMaskLo: number;
  hasUpper: boolean;
  lower: string;
  raw: string;
}

interface ScoredMatchDetail {
  ranges: PathMatchRange[];
  score: number;
}

const DEFAULT_STALE_TTL_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ROOTS = 32;
const DEFAULT_MAX_ENTRIES_PER_ROOT = 250_000;
const EMPTY_DIR_SCAN_MAX_DIRS = 5_000;
const EMPTY_DIR_SCAN_BUDGET_MS = 1_500;
const MAX_MRU_PATHS_PER_ROOT = 256;
const MAX_FUZZY_TOKEN_LENGTH = 64;
const MAX_FUZZY_HAYSTACK_LENGTH = 512;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function charBitIndex(code: number): number {
  if (code >= 97 && code <= 122) return code - 97; // a-z: 0..25
  if (code >= 48 && code <= 57) return 26 + (code - 48); // 0-9: 26..35
  switch (code) {
    case 47: return 36; // /
    case 46: return 37; // .
    case 95: return 38; // _
    case 45: return 39; // -
    case 32: return 40; // space
    default: return code > 127 ? 63 : -1;
  }
}

export function computeCharBag(lowerText: string): { hi: number; lo: number } {
  let lo = 0;
  let hi = 0;
  for (let index = 0; index < lowerText.length; index += 1) {
    const bit = charBitIndex(lowerText.charCodeAt(index));
    if (bit < 0) continue;
    if (bit < 32) lo |= 1 << bit;
    else hi |= 1 << (bit - 32);
  }
  return { hi, lo };
}

function parseQueryTokens(query: string): ParsedQueryToken[] {
  const cleaned = query
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
  if (!cleaned) return [];
  const rawTokens = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  return rawTokens.map(raw => {
    const lower = raw.toLowerCase();
    const bag = computeCharBag(lower);
    return {
      raw,
      lower,
      hasUpper: raw !== lower,
      charMaskLo: bag.lo,
      charMaskHi: bag.hi,
    };
  });
}

function createIndexedEntry(
  normalizedPath: string,
  entryType: 'directory' | 'file',
  searchIgnored: boolean,
): WorkspaceSearchIndexedEntry {
  const slashIndex = normalizedPath.lastIndexOf('/');
  const basenameOffset = slashIndex === -1 ? 0 : slashIndex + 1;
  const basename = basenameOffset === 0 ? normalizedPath : normalizedPath.slice(basenameOffset);
  const lowerPath = normalizedPath.toLowerCase();
  const lowerBasename = basenameOffset === 0 ? lowerPath : lowerPath.slice(basenameOffset);
  const bag = computeCharBag(lowerPath);
  let depth = 1;
  for (let index = 0; index < normalizedPath.length; index += 1) {
    if (normalizedPath.charCodeAt(index) === 47) depth += 1;
  }
  return {
    path: normalizedPath,
    lowerPath,
    basename,
    lowerBasename,
    basenameOffset,
    depth,
    entryType,
    charMaskLo: bag.lo,
    charMaskHi: bag.hi,
    searchIgnored,
  };
}

function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = text.charCodeAt(index - 1);
  // / \ - _ . space
  if (
    previous === 47 || previous === 92 || previous === 45
    || previous === 95 || previous === 46 || previous === 32
  ) {
    return true;
  }
  const current = text.charCodeAt(index);
  // camelCase boundary: [a-z0-9][A-Z]
  const prevLowerOrDigit = (previous >= 97 && previous <= 122) || (previous >= 48 && previous <= 57);
  const currUpper = current >= 65 && current <= 90;
  return prevLowerOrDigit && currUpper;
}

function mergeRanges(ranges: PathMatchRange[]): PathMatchRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: PathMatchRange[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index];
    const current = merged[merged.length - 1];
    if (next.start <= current.end) {
      if (next.end > current.end) current.end = next.end;
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

function isSubsequence(lowerText: string, lowerToken: string): boolean {
  let tokenIndex = 0;
  const tokenLength = lowerToken.length;
  for (let textIndex = 0; textIndex < lowerText.length && tokenIndex < tokenLength; textIndex += 1) {
    if (lowerText.charCodeAt(textIndex) === lowerToken.charCodeAt(tokenIndex)) {
      tokenIndex += 1;
    }
  }
  return tokenIndex === tokenLength;
}

/**
 * Optimal subsequence alignment with fzf/nucleo-inspired bonuses:
 * - consecutive matches
 * - path separator / word boundary / camelCase matches
 * - filename (basename) matches
 * - Smart Case soft bonus when query has uppercase letters
 * - gap penalty to keep matches compact
 *
 * Returns a positive quality score (higher is better) and exact matched UTF-16 ranges,
 * or null if token is not a subsequence.
 */
function fuzzyAlignToken(
  rawText: string,
  lowerText: string,
  basenameOffset: number,
  token: ParsedQueryToken,
  startOffset = 0,
): { quality: number; ranges: PathMatchRange[] } | null {
  const tokenLen = token.lower.length;
  const textLen = lowerText.length;
  if (tokenLen === 0 || textLen < startOffset + tokenLen) return null;

  // Quick forward subsequence verification (rejects >95% of non-matches in O(N)).
  let firstMatch = -1;
  let lastForwardMatch = -1;
  {
    let ti = 0;
    for (let si = startOffset; si < textLen && ti < tokenLen; si += 1) {
      if (lowerText.charCodeAt(si) === token.lower.charCodeAt(ti)) {
        if (firstMatch === -1) firstMatch = si;
        lastForwardMatch = si;
        ti += 1;
      }
    }
    if (ti < tokenLen) return null;
  }

  // Narrow window around matchable span to keep DP small even on long paths.
  const windowStart = firstMatch;
  let windowEnd = lastForwardMatch;
  // Extend windowEnd to last occurrence of last token char so basename matches win over earlier dir matches.
  const lastCharCode = token.lower.charCodeAt(tokenLen - 1);
  for (let si = textLen - 1; si > lastForwardMatch; si -= 1) {
    if (lowerText.charCodeAt(si) === lastCharCode) {
      windowEnd = si;
      break;
    }
  }

  const sliceLen = windowEnd - windowStart + 1;
  if (tokenLen > MAX_FUZZY_TOKEN_LENGTH || sliceLen > MAX_FUZZY_HAYSTACK_LENGTH) {
    // Bounded greedy boundary-first fallback for unusually long queries/paths.
    const positions: number[] = [];
    let ti = 0;
    for (let si = windowStart; si <= windowEnd && ti < tokenLen; si += 1) {
      if (lowerText.charCodeAt(si) === token.lower.charCodeAt(ti)) {
        positions.push(si);
        ti += 1;
      }
    }
    if (positions.length !== tokenLen) return null;
    const ranges = mergeRanges(positions.map(pos => ({ start: pos, end: pos + 1 })));
    return { quality: 20, ranges };
  }

  // Precompute per-character position bonuses for the active window.
  const bonus = new Int16Array(sliceLen);
  for (let k = 0; k < sliceLen; k += 1) {
    const absPos = windowStart + k;
    let b = 0;
    if (absPos === basenameOffset) {
      b += 34; // start of filename
    } else if (absPos === 0) {
      b += 24; // start of path
    } else {
      const prev = rawText.charCodeAt(absPos - 1);
      if (prev === 47 || prev === 92) {
        b += 28; // right after path separator
      } else if (prev === 95 || prev === 45 || prev === 46 || prev === 32) {
        b += 22; // right after delimiter
      } else if (isWordBoundary(rawText, absPos)) {
        b += 20; // camelCase boundary
      }
    }
    if (absPos >= basenameOffset) {
      b += 10; // inside basename
    }
    bonus[k] = b;
  }

  const NEG_INF = -1_000_000;
  // M[i * sliceLen + j]: best score when token[0..i] matched with token[i] at windowStart + j
  // D[i * sliceLen + j]: best score for token[0..i] ending at or before windowStart + j
  const size = tokenLen * sliceLen;
  const M = new Int32Array(size);
  const D = new Int32Array(size);
  M.fill(NEG_INF);
  D.fill(NEG_INF);

  for (let i = 0; i < tokenLen; i += 1) {
    const tokenCharLower = token.lower.charCodeAt(i);
    const tokenCharRaw = token.raw.charCodeAt(i);
    const rowOffset = i * sliceLen;
    const prevRowOffset = (i - 1) * sliceLen;
    let bestSoFar = NEG_INF;

    for (let j = i; j < sliceLen; j += 1) {
      const absPos = windowStart + j;
      if (lowerText.charCodeAt(absPos) === tokenCharLower) {
        let charScore = 16 + bonus[j];
        if (token.hasUpper && rawText.charCodeAt(absPos) === tokenCharRaw) {
          charScore += 6;
        }
        let score: number;
        if (i === 0) {
          score = charScore - Math.min(24, Math.floor((absPos - startOffset) / 4));
        } else {
          const consecutive = M[prevRowOffset + (j - 1)];
          const gapBest = D[prevRowOffset + (j - 1)];
          const fromConsecutive = consecutive > NEG_INF ? consecutive + charScore + 18 : NEG_INF;
          const fromGap = gapBest > NEG_INF ? gapBest + charScore - 3 : NEG_INF;
          score = fromConsecutive >= fromGap ? fromConsecutive : fromGap;
        }
        M[rowOffset + j] = score;
        if (score > bestSoFar) bestSoFar = score;
      }
      // Small gap penalty per skipped character while carrying D forward.
      const carried = bestSoFar > NEG_INF ? bestSoFar - 1 : NEG_INF;
      const prevD = j > 0 ? D[rowOffset + j - 1] - 1 : NEG_INF;
      D[rowOffset + j] = M[rowOffset + j] >= prevD
        ? (M[rowOffset + j] >= carried ? M[rowOffset + j] : carried)
        : prevD;
      if (D[rowOffset + j] > bestSoFar) bestSoFar = D[rowOffset + j];
    }
  }

  // Pick the best ending position in the last row.
  const lastRowOffset = (tokenLen - 1) * sliceLen;
  let bestEnd = -1;
  let bestScore = NEG_INF;
  for (let j = tokenLen - 1; j < sliceLen; j += 1) {
    const score = M[lastRowOffset + j];
    if (score > bestScore) {
      bestScore = score;
      bestEnd = j;
    }
  }
  if (bestEnd === -1 || bestScore <= NEG_INF) return null;

  // Backtrack to recover exact matched indices.
  const positions = new Array<number>(tokenLen);
  let currJ = bestEnd;
  for (let i = tokenLen - 1; i >= 0; i -= 1) {
    positions[i] = windowStart + currJ;
    if (i === 0) break;
    const prevRowOffset = (i - 1) * sliceLen;
    const prevConsec = currJ > 0 ? M[prevRowOffset + currJ - 1] : NEG_INF;
    let bestPrevJ = currJ - 1;
    let bestPrevVal = prevConsec > NEG_INF ? prevConsec + 18 : NEG_INF;
    for (let k = currJ - 1; k >= i - 1; k -= 1) {
      const val = M[prevRowOffset + k];
      if (val <= NEG_INF) continue;
      const gapPenalty = (currJ - 1 - k) + 3;
      const candidate = val - gapPenalty;
      if (candidate > bestPrevVal) {
        bestPrevVal = candidate;
        bestPrevJ = k;
      }
    }
    currJ = bestPrevJ;
  }

  const ranges = mergeRanges(positions.map(pos => ({ start: pos, end: pos + 1 })));
  const span = positions[tokenLen - 1] - positions[0] + 1;

  // Reject ultra-scattered false positives (e.g. "NewFile" matching "n-e-w-f-i-l-e"
  // or a short token like "buf" spanning unrelated directories ".../subquery/udf").
  if (tokenLen >= 3) {
    let consecutivePairs = 0;
    let realWordBoundaryHits = 0;
    for (let i = 0; i < tokenLen; i += 1) {
      const pos = positions[i];
      if (i > 0 && pos === positions[i - 1] + 1) consecutivePairs += 1;
      if (isWordBoundary(rawText, pos)) {
        const nextCode = pos + 1 < rawText.length ? rawText.charCodeAt(pos + 1) : 0;
        const nextIsAlphaNum = (nextCode >= 65 && nextCode <= 90)
          || (nextCode >= 97 && nextCode <= 122)
          || (nextCode >= 48 && nextCode <= 57);
        if (nextIsAlphaNum) realWordBoundaryHits += 1;
      }
    }
    const isRealAcronym = realWordBoundaryHits === tokenLen;
    if (!isRealAcronym) {
      if (tokenLen >= 3 && consecutivePairs === 0) return null;
      if (tokenLen >= 5 && consecutivePairs < Math.floor(tokenLen / 3) && span > tokenLen * 4) return null;
      if (startOffset === 0 && basenameOffset > 0 && positions[0] < basenameOffset && span > Math.max(24, tokenLen * 4)) {
        return null;
      }
    }
  }

  return { quality: bestScore, ranges };
}

function matchRealWordBoundaryAcronym(
  rawText: string,
  lowerText: string,
  token: ParsedQueryToken,
): PathMatchRange[] | null {
  const tokenLen = token.lower.length;
  if (tokenLen < 2 || tokenLen > 12) return null;
  const positions: number[] = [];
  let ti = 0;
  for (let i = 0; i < lowerText.length && ti < tokenLen; i += 1) {
    if (!isWordBoundary(rawText, i)) continue;
    if (lowerText.charCodeAt(i) !== token.lower.charCodeAt(ti)) continue;
    // Require the word at this boundary to be a real word (at least 2 alphanumeric chars),
    // so dummy single-letter segments like "n-e-w-f-i-l-e" do not qualify as acronyms.
    const nextCode = i + 1 < rawText.length ? rawText.charCodeAt(i + 1) : 0;
    const nextIsAlphaNum = (nextCode >= 65 && nextCode <= 90)
      || (nextCode >= 97 && nextCode <= 122)
      || (nextCode >= 48 && nextCode <= 57);
    if (!nextIsAlphaNum) continue;
    positions.push(i);
    ti += 1;
  }
  if (ti !== tokenLen) return null;
  return mergeRanges(positions.map(pos => ({ start: pos, end: pos + 1 })));
}

function scoreSingleToken(
  entry: WorkspaceSearchIndexedEntry,
  token: ParsedQueryToken,
  allowPathMatch: boolean,
  effectiveLowerPath: string,
  effectiveRawPath: string,
  effectiveBasenameOffset: number,
): ScoredMatchDetail | null {
  // Fast bitmask reject before scanning characters.
  if ((entry.charMaskLo & token.charMaskLo) !== token.charMaskLo) return null;
  if ((entry.charMaskHi & token.charMaskHi) !== token.charMaskHi) return null;

  const lowerToken = token.lower;
  const lowerName = entry.lowerBasename;
  const rawName = entry.basename;
  const nameOffset = entry.basenameOffset;
  const pathDelta = entry.path.length - effectiveRawPath.length;

  // Tier 0: Exact full path match
  if (effectiveLowerPath === lowerToken) {
    const casePenalty = token.hasUpper && effectiveRawPath !== token.raw ? 0.05 : 0;
    return {
      score: 0 + casePenalty,
      ranges: [{ start: pathDelta, end: entry.path.length }],
    };
  }

  // Tier 1: Exact filename / directory name match
  if (lowerName === lowerToken) {
    const casePenalty = token.hasUpper && rawName !== token.raw ? 0.05 : 0;
    return {
      score: 1 + casePenalty,
      ranges: [{ start: nameOffset, end: entry.path.length }],
    };
  }

  // Tier 2: Filename prefix match
  if (lowerName.startsWith(lowerToken)) {
    const casePenalty = token.hasUpper && !rawName.startsWith(token.raw) ? 0.05 : 0;
    return {
      score: 3 + (lowerName.length - lowerToken.length) * 0.001 + casePenalty,
      ranges: [{ start: nameOffset, end: nameOffset + lowerToken.length }],
    };
  }

  // Tier 2.5: Filename word-boundary acronym (e.g. "fep" -> "FileEditorPane.tsx")
  // Ranks ahead of mid-word substrings (e.g. "fep" inside "gc_safepoint").
  const acronymRanges = matchRealWordBoundaryAcronym(rawName, lowerName, token);
  if (acronymRanges) {
    const firstPos = acronymRanges[0]?.start ?? 0;
    return {
      score: 6 + firstPos * 0.05 + lowerName.length * 0.001,
      ranges: acronymRanges.map(r => ({ start: nameOffset + r.start, end: nameOffset + r.end })),
    };
  }

  // Tier 3: Filename substring match (prefer word-boundary start)
  const nameIndex = lowerName.indexOf(lowerToken);
  if (nameIndex !== -1) {
    const boundaryBonus = isWordBoundary(rawName, nameIndex) ? 0 : 4;
    const casePenalty = token.hasUpper && rawName.slice(nameIndex, nameIndex + lowerToken.length) !== token.raw ? 0.05 : 0;
    return {
      score: 8 + boundaryBonus + nameIndex * 0.25 + (lowerName.length - lowerToken.length) * 0.001 + casePenalty,
      ranges: [{ start: nameOffset + nameIndex, end: nameOffset + nameIndex + lowerToken.length }],
    };
  }

  // Tier 4: Basename fuzzy alignment (supports arbitrary length > 6!)
  if (isSubsequence(lowerName, lowerToken)) {
    const aligned = fuzzyAlignToken(rawName, lowerName, 0, token, 0);
    if (aligned) {
      // Lower score is better; map high alignment quality into [18, 34].
      const normalizedQuality = Math.max(0, Math.min(16, aligned.quality / (lowerToken.length * 4)));
      const score = 34 - normalizedQuality + lowerName.length * 0.002;
      return {
        score,
        ranges: aligned.ranges.map(r => ({ start: nameOffset + r.start, end: nameOffset + r.end })),
      };
    }
  }

  if (!allowPathMatch) return null;

  // Tier 5: Exact directory segment match in path
  if (effectiveBasenameOffset > 0) {
    const dirPart = effectiveLowerPath.slice(0, effectiveBasenameOffset - 1);
    const segments = dirPart.split('/');
    let segOffset = 0;
    for (let i = 0; i < segments.length; i += 1) {
      if (segments[i] === lowerToken) {
        return {
          score: 36 + i * 0.5,
          ranges: [{ start: pathDelta + segOffset, end: pathDelta + segOffset + lowerToken.length }],
        };
      }
      segOffset += segments[i].length + 1;
    }
  }

  // Tier 6: Full path substring match
  const pathIndex = effectiveLowerPath.indexOf(lowerToken);
  if (pathIndex !== -1) {
    const boundaryBonus = isWordBoundary(effectiveRawPath, pathIndex) ? 0 : 3;
    const casePenalty = token.hasUpper
      && effectiveRawPath.slice(pathIndex, pathIndex + lowerToken.length) !== token.raw ? 0.05 : 0;
    return {
      score: 42 + boundaryBonus + pathIndex * 0.1 + casePenalty,
      ranges: [{ start: pathDelta + pathIndex, end: pathDelta + pathIndex + lowerToken.length }],
    };
  }

  // Tier 7: Full path fuzzy alignment (supports arbitrary length > 6!)
  const fullAligned = fuzzyAlignToken(
    effectiveRawPath,
    effectiveLowerPath,
    effectiveBasenameOffset,
    token,
    0,
  );
  if (!fullAligned) return null;
  const maxQuality = Math.max(1, lowerToken.length * 50);
  const qualityRatio = Math.max(0, Math.min(1, fullAligned.quality / maxQuality));
  const score = 75 - qualityRatio * 22 + effectiveRawPath.length * 0.01;
  return {
    score,
    ranges: fullAligned.ranges.map(r => ({ start: pathDelta + r.start, end: pathDelta + r.end })),
  };
}

export function scoreIndexedEntry(
  entry: WorkspaceSearchIndexedEntry,
  tokens: readonly ParsedQueryToken[],
  allowPathMatch: boolean,
  pathPrefix = '',
  mruBonus = 0,
): ScoredMatchDetail | null {
  if (tokens.length === 0) return null;

  let effectiveRawPath = entry.path;
  let effectiveLowerPath = entry.lowerPath;
  let effectiveBasenameOffset = entry.basenameOffset;
  if (pathPrefix) {
    const prefixSlash = `${pathPrefix}/`;
    if (!entry.path.startsWith(prefixSlash)) return null;
    effectiveRawPath = entry.path.slice(prefixSlash.length);
    effectiveLowerPath = entry.lowerPath.slice(prefixSlash.length);
    effectiveBasenameOffset = Math.max(0, entry.basenameOffset - prefixSlash.length);
  }

  if (tokens.length === 1) {
    const single = scoreSingleToken(
      entry,
      tokens[0],
      allowPathMatch,
      effectiveLowerPath,
      effectiveRawPath,
      effectiveBasenameOffset,
    );
    if (!single) return null;
    return {
      score: Math.max(0, single.score - mruBonus),
      ranges: single.ranges,
    };
  }

  // Multi-token query: every token must match somewhere in the entry path/name.
  // Allow full-path matching automatically for multi-token queries (e.g. "streamline buf").
  // Reject fast using combined bitmask before scoring individual tokens.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if ((entry.charMaskLo & token.charMaskLo) !== token.charMaskLo) return null;
    if ((entry.charMaskHi & token.charMaskHi) !== token.charMaskHi) return null;
  }
  let totalScore = 0;
  const allRanges: PathMatchRange[] = [];
  let basenameHits = 0;
  for (const token of tokens) {
    const detail = scoreSingleToken(
      entry,
      token,
      true,
      effectiveLowerPath,
      effectiveRawPath,
      effectiveBasenameOffset,
    );
    if (!detail) return null;
    totalScore += detail.score;
    for (const range of detail.ranges) {
      allRanges.push(range);
      if (range.start >= entry.basenameOffset) basenameHits += 1;
    }
  }
  const avgScore = totalScore / tokens.length;
  const multiBasenameBonus = basenameHits >= tokens.length ? 3 : 0;
  return {
    score: Math.max(0, avgScore - multiBasenameBonus - mruBonus),
    ranges: mergeRanges(allRanges),
  };
}

function compareWorkspaceSearchMatches(a: WorkspaceSearchMatch, b: WorkspaceSearchMatch): number {
  const depthDiff = pathDepth(a.path) - pathDepth(b.path);
  return (
    a.score - b.score
    || depthDiff
    || (a.entryType === 'directory' ? 0 : 1) - (b.entryType === 'directory' ? 0 : 1)
    || a.path.localeCompare(b.path)
  );
}

function pathDepth(filePath: string): number {
  if (!filePath) return 0;
  let depth = 1;
  for (let index = 0; index < filePath.length; index += 1) {
    if (filePath.charCodeAt(index) === 47) depth += 1;
  }
  return depth;
}

function raceWithSignalAndTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException('Workspace search was cancelled', 'AbortError'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Workspace search was cancelled', 'AbortError'),
      ));
    };
    const timer = setTimeout(() => {
      const error = new Error('Workspace search index build timed out') as Error & { code?: string };
      error.code = 'ETIMEDOUT';
      finish(() => reject(error));
    }, Math.max(100, timeoutMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

export class WorkspaceSearchIndex {
  private readonly excludeGlobArgs: () => string[];
  private readonly idleTtlMs: number;
  private readonly isSearchIgnored: (relativePath: string) => boolean;
  private readonly maxEntriesPerRoot: number;
  private readonly maxRoots: number;
  private readonly pruneEmptyDirectoryScan: (relativePath: string) => boolean;
  private readonly rgPath: () => string;
  private readonly roots = new Map<string, RootIndexState>();
  private readonly staleTtlMs: number;
  private disposed = false;

  constructor(options: WorkspaceSearchIndexOptions) {
    this.rgPath = options.rgPath;
    this.excludeGlobArgs = options.excludeGlobArgs;
    this.isSearchIgnored = options.isSearchIgnored;
    this.pruneEmptyDirectoryScan = options.pruneEmptyDirectoryScan || options.isSearchIgnored;
    this.staleTtlMs = options.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxRoots = Math.max(1, options.maxRoots ?? DEFAULT_MAX_ROOTS);
    this.maxEntriesPerRoot = Math.max(1_000, options.maxEntriesPerRoot ?? DEFAULT_MAX_ENTRIES_PER_ROOT);
  }

  recordPathAccess(root: string, relativePath: string): void {
    const normalized = normalizeRelativePath(relativePath);
    if (!root || !normalized) return;
    const state = this.roots.get(root);
    if (!state) return;
    state.mruPaths.delete(normalized);
    state.mruPaths.set(normalized, Date.now());
    while (state.mruPaths.size > MAX_MRU_PATHS_PER_ROOT) {
      const oldest = state.mruPaths.keys().next().value;
      if (oldest === undefined) break;
      state.mruPaths.delete(oldest);
    }
  }

  invalidate(root: string): void {
    const state = this.roots.get(root);
    if (!state) return;
    state.generation += 1;
    state.snapshot = null;
    if (state.activeBuild) {
      try {
        state.activeBuild.child?.kill();
      } catch {
        // Ignore already-exited child.
      }
      state.activeBuild = null;
    }
  }

  invalidateAll(): void {
    for (const root of Array.from(this.roots.keys())) {
      this.invalidate(root);
    }
  }

  getStats(root: string): {
    building: boolean;
    directoryCount: number;
    fileCount: number;
    ready: boolean;
    truncated: boolean;
  } {
    const state = this.roots.get(root);
    return {
      ready: Boolean(state?.snapshot),
      building: Boolean(state?.activeBuild),
      fileCount: state?.snapshot?.files.length ?? 0,
      directoryCount: state?.snapshot?.directories.length ?? 0,
      truncated: Boolean(state?.snapshot?.truncated),
    };
  }

  warm(root: string): Promise<void> {
    if (this.disposed || !root) return Promise.resolve();
    const state = this.getOrCreateState(root);
    state.lastAccessedAt = Date.now();
    if (state.snapshot && Date.now() - state.snapshot.builtAt < this.staleTtlMs) {
      return Promise.resolve();
    }
    return this.ensureBuild(root, state, true).promise.then(() => {}, () => {});
  }

  async search(
    root: string,
    query: string,
    options: WorkspaceSearchQueryOptions,
  ): Promise<WorkspaceSearchQueryResult> {
    if (this.disposed) {
      return { matches: [], truncated: false, cacheHit: false };
    }
    options.signal?.throwIfAborted();
    this.evictIdleRoots();

    const tokens = parseQueryTokens(query);
    if (tokens.length === 0) {
      return { matches: [], truncated: false, cacheHit: true };
    }

    const state = this.getOrCreateState(root);
    const now = Date.now();
    state.lastAccessedAt = now;

    let snapshot = state.snapshot;
    let cacheHit = false;
    if (snapshot) {
      const checkedSnapshot = snapshot;
      const currentFingerprint = await this.computeQuickFingerprint(root, checkedSnapshot.directories);
      options.signal?.throwIfAborted();
      if (currentFingerprint !== checkedSnapshot.fingerprint) {
        if (state.snapshot === checkedSnapshot) {
          this.invalidate(root);
        }
        snapshot = state.snapshot;
      }
    }
    if (snapshot) {
      cacheHit = true;
      if (now - snapshot.builtAt >= this.staleTtlMs && !state.activeBuild) {
        // Serve warm snapshot immediately and refresh in background (T3 Code pattern).
        void this.ensureBuild(root, state, true).promise.catch(() => {});
      }
    } else {
      const build = this.ensureBuild(root, state, false);
      build.waiters += 1;
      try {
        snapshot = await raceWithSignalAndTimeout(build.promise, options.timeoutMs, options.signal);
      } finally {
        build.waiters = Math.max(0, build.waiters - 1);
        if (build.waiters === 0 && !build.background && state.activeBuild === build) {
          this.cancelBuild(state, build);
        }
      }
    }

    const includeFiles = options.includeFiles !== false;
    const includeDirectories = options.includeDirectories !== false;
    const includeSearchIgnoredDirectories = options.includeSearchIgnoredDirectories === true;
    const allowPathMatch = options.allowPathMatch ?? (tokens.length > 1 || /[./\\]/.test(query));
    const pathPrefix = options.pathPrefix && options.pathPrefix !== '.'
      ? normalizeRelativePath(options.pathPrefix)
      : '';
    const limit = Math.max(1, Math.min(500, options.limit));
    const candidateCap = Math.max(120, limit * 8);

    const scored: WorkspaceSearchMatch[] = [];
    let matchOverflow = false;

    const consider = (entry: WorkspaceSearchIndexedEntry) => {
      const mruTime = state.mruPaths.get(entry.path);
      const mruBonus = mruTime ? 0.5 : 0;
      const detail = scoreIndexedEntry(entry, tokens, allowPathMatch, pathPrefix, mruBonus);
      if (!detail) return;
      scored.push({
        path: entry.path,
        entryType: entry.entryType,
        score: detail.score,
        ranges: detail.ranges,
      });
      if (scored.length >= candidateCap) {
        matchOverflow = true;
        scored.sort(compareWorkspaceSearchMatches);
        scored.length = limit;
      }
    };

    if (includeDirectories) {
      for (let index = 0; index < snapshot.directories.length; index += 1) {
        const entry = snapshot.directories[index];
        if (!includeSearchIgnoredDirectories && entry.searchIgnored) continue;
        consider(entry);
      }
    }
    if (includeFiles) {
      for (let index = 0; index < snapshot.files.length; index += 1) {
        consider(snapshot.files[index]);
      }
    }

    scored.sort(compareWorkspaceSearchMatches);
    const matches = scored.slice(0, limit);
    return {
      matches,
      truncated: snapshot.truncated || matchOverflow || scored.length > limit,
      cacheHit,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.roots.values()) {
      state.generation += 1;
      state.snapshot = null;
      if (state.activeBuild) {
        try {
          state.activeBuild.child?.kill();
        } catch {
          // Ignore already-exited child.
        }
        state.activeBuild = null;
      }
    }
    this.roots.clear();
  }

  private getOrCreateState(root: string): RootIndexState {
    let state = this.roots.get(root);
    if (!state) {
      this.evictIfOverCapacity();
      state = {
        snapshot: null,
        activeBuild: null,
        generation: 0,
        lastAccessedAt: Date.now(),
        mruPaths: new Map(),
      };
      this.roots.set(root, state);
    }
    return state;
  }

  private evictIdleRoots(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [root, state] of this.roots.entries()) {
      if (!state.activeBuild && state.lastAccessedAt < cutoff) {
        this.roots.delete(root);
      }
    }
  }

  private evictIfOverCapacity(): void {
    if (this.roots.size < this.maxRoots) return;
    let oldestRoot = '';
    let oldestTime = Infinity;
    for (const [root, state] of this.roots.entries()) {
      if (state.activeBuild) continue;
      if (state.lastAccessedAt < oldestTime) {
        oldestTime = state.lastAccessedAt;
        oldestRoot = root;
      }
    }
    if (oldestRoot) {
      this.roots.delete(oldestRoot);
    }
  }

  private cancelBuild(state: RootIndexState, build: ActiveBuild): void {
    if (state.activeBuild === build) {
      state.activeBuild = null;
    }
    if (build.child) {
      try {
        build.child.kill('SIGTERM');
      } catch {
        // Ignore already-exited child.
      }
      build.child = null;
    }
  }

  private ensureBuild(root: string, state: RootIndexState, background: boolean): ActiveBuild {
    if (state.activeBuild) {
      if (background) state.activeBuild.background = true;
      return state.activeBuild;
    }
    const generation = state.generation;
    const activeBuild: ActiveBuild = {
      background,
      child: null,
      generation,
      waiters: 0,
      promise: Promise.resolve({
        builtAt: 0,
        files: [],
        directories: [],
        fingerprint: '',
        truncated: false,
      }),
    };
    const promise = this.buildSnapshot(root, activeBuild)
      .then(snapshot => {
        if (!this.disposed && state.generation === generation) {
          state.snapshot = snapshot;
          state.lastAccessedAt = Date.now();
        }
        return snapshot;
      })
      .finally(() => {
        if (state.activeBuild === activeBuild) {
          state.activeBuild = null;
        }
      });
    activeBuild.promise = promise;
    state.activeBuild = activeBuild;
    return activeBuild;
  }

  private async buildSnapshot(
    root: string,
    activeBuild: ActiveBuild,
  ): Promise<WorkspaceSearchSnapshot> {
    const [rgResult, emptyDirs] = await Promise.all([
      this.scanFilesWithRipgrep(root, activeBuild),
      this.scanDirectoriesBounded(root),
    ]);

    const files = rgResult.files;
    const dirSet = new Set<string>();
    const directories: WorkspaceSearchIndexedEntry[] = [];

    const addDirectory = (dirPath: string) => {
      if (!dirPath || dirSet.has(dirPath)) return;
      dirSet.add(dirPath);
      directories.push(createIndexedEntry(dirPath, 'directory', this.isSearchIgnored(dirPath)));
    };

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index].path;
      let slashIndex = filePath.lastIndexOf('/');
      while (slashIndex > 0) {
        const dirPath = filePath.slice(0, slashIndex);
        if (dirSet.has(dirPath)) break;
        addDirectory(dirPath);
        slashIndex = filePath.lastIndexOf('/', slashIndex - 1);
      }
    }

    for (const dirPath of emptyDirs) {
      addDirectory(dirPath);
    }

    const fingerprint = await this.computeQuickFingerprint(root, directories);

    return {
      builtAt: Date.now(),
      files,
      directories,
      fingerprint,
      truncated: rgResult.truncated,
    };
  }

  /**
   * Cheap (<0.5ms) stat fingerprint so external filesystem writes (e.g. an AI agent
   * creating files in a terminal, git checkout, or test fixtures) invalidate the
   * cached snapshot immediately without spawning ripgrep.
   */
  private async computeQuickFingerprint(
    root: string,
    directories: readonly WorkspaceSearchIndexedEntry[],
  ): Promise<string> {
    const targets = [
      root,
      path.join(root, '.git', 'HEAD'),
      path.join(root, '.git', 'index'),
    ];
    if (directories.length <= 32) {
      for (let index = 0; index < directories.length; index += 1) {
        targets.push(path.join(root, directories[index].path));
      }
    }
    const parts = await Promise.all(targets.map(async target => {
      try {
        const stat = await fsp.stat(target);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return '-';
      }
    }));
    return parts.join('|');
  }

  private scanFilesWithRipgrep(
    root: string,
    activeBuild: ActiveBuild,
  ): Promise<{ files: WorkspaceSearchIndexedEntry[]; truncated: boolean }> {
    const args = [
      '--files',
      '--hidden',
      ...this.excludeGlobArgs(),
      '.',
    ];
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.rgPath(), args, {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }
      activeBuild.child = child;
      const files: WorkspaceSearchIndexedEntry[] = [];
      let pending = '';
      let stderr = '';
      let settled = false;
      let truncated = false;

      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        activeBuild.child = null;
        if (error) {
          reject(error);
          return;
        }
        resolve({ files, truncated });
      };

      const processLine = (line: string) => {
        const normalized = normalizeRelativePath(line);
        if (!normalized || this.isSearchIgnored(normalized)) return;
        if (files.length >= this.maxEntriesPerRoot) {
          truncated = true;
          try {
            child.kill();
          } catch {
            // Ignore kill error.
          }
          finish();
          return;
        }
        files.push(createIndexedEntry(normalized, 'file', false));
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        pending += String(chunk || '');
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          processLine(line);
          if (settled) return;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += String(chunk || '');
      });

      child.on('error', (error: Error) => {
        finish(error);
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (pending) processLine(pending);
        if (settled) return;
        // ripgrep exits with 1 when a directory contains no searchable files.
        if ((code && code !== 1) || (signal && !truncated)) {
          const error = new Error(stderr || 'workspace index scan failed') as Error & {
            code?: number;
            signal?: NodeJS.Signals | null;
            stderr?: string;
          };
          error.code = code ?? undefined;
          error.signal = signal;
          error.stderr = stderr;
          finish(error);
          return;
        }
        finish();
      });
    });
  }

  private async scanDirectoriesBounded(root: string): Promise<string[]> {
    const discovered: string[] = [];
    const queue: Array<{ relativePath: string; target: string }> = [{ target: root, relativePath: '' }];
    const deadline = Date.now() + EMPTY_DIR_SCAN_BUDGET_MS;
    let visited = 0;

    while (queue.length > 0 && visited < EMPTY_DIR_SCAN_MAX_DIRS && Date.now() < deadline && !this.disposed) {
      const current = queue.shift();
      if (!current) continue;
      if (current.relativePath && this.pruneEmptyDirectoryScan(current.relativePath)) continue;
      visited += 1;

      let entries: import('fs').Dirent[];
      try {
        entries = await fsp.readdir(current.target, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childRelativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        if (this.pruneEmptyDirectoryScan(childRelativePath)) continue;
        discovered.push(childRelativePath);
        queue.push({
          target: path.join(current.target, entry.name),
          relativePath: childRelativePath,
        });
      }
    }

    return discovered;
  }
}
