import type { Root } from 'mdast'
import type {} from 'remark-parse'
import { attention } from 'micromark-core-commonmark'
import type { Code, Construct, Token } from 'micromark-util-types'
import type { Plugin } from 'unified'

// Only Chinese punctuation inside an exact ** pair gets relaxed boundaries.
// Keep CommonMark's tokenizer/resolver in charge of escaping, nesting and pairing.
const chinesePunctuation = /^[，。！？；：、（）【】《》〈〉「」『』〔〕［］｛｝“”‘’…—]$/u
const word = /^[\p{L}\p{N}]$/u
function matches(code: Code, pattern: RegExp): boolean {
  return code !== null && code > 0 && pattern.test(String.fromCodePoint(code))
}

const chineseStrong: Construct = {
  ...attention,
  tokenize(effects, ok, nok) {
    const previous = this.previous
    let sequence: Token | undefined
    return attention.tokenize.call(this, {
      ...effects,
      exit(type) {
        const token = effects.exit(type)
        if (token.type === 'attentionSequence') sequence = token
        return token
      },
    }, (next) => {
      if (sequence && this.sliceSerialize(sequence) === '**') {
        if (matches(previous, chinesePunctuation) && matches(next, word)) {
          sequence._close = true
        } else if (matches(previous, word) && matches(next, chinesePunctuation)) {
          sequence._open = true
        }
      }
      return ok(next)
    }, nok)
  },
}

export const remarkChineseStrong: Plugin<[], Root> = function () {
  const data = this.data()
  const extensions = data.micromarkExtensions || (data.micromarkExtensions = [])
  extensions.push({ text: { 42: chineseStrong } })
}
