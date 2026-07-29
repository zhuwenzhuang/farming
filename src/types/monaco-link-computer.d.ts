declare module 'monaco-editor/esm/vs/editor/common/languages/linkComputer.js' {
  interface LinkComputerTarget {
    getLineCount(): number
    getLineContent(lineNumber: number): string
  }

  interface ComputedLink {
    range: {
      startColumn: number
      endColumn: number
    }
    url: string
  }

  export class LinkComputer {
    static computeLinks(target: LinkComputerTarget): ComputedLink[]
  }
}
