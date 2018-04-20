import EventEmitter from 'events'
import fs from 'fs'
import fetch from 'node-fetch'
import path from 'path'
import temme, { cheerio, temmeParser } from 'temme'
import {
  CancellationToken,
  CodeActionContext,
  CodeActionProvider,
  Command,
  commands,
  Diagnostic,
  DiagnosticCollection,
  DocumentFilter,
  DocumentSymbolProvider,
  ExtensionContext,
  languages,
  Position,
  Range,
  SymbolInformation,
  TextDocument,
  Uri,
  ViewColumn,
  window,
  workspace,
  StatusBarItem,
  StatusBarAlignment,
  TextDocumentChangeEvent,
  WorkspaceEdit,
  OutputChannel,
} from 'vscode'

const TEMME_MODE: DocumentFilter = { language: 'temme', scheme: 'file' }
const TAGGED_LINK_PATTERN = /(<.*>)\s*(.+)$/

type Status = 'idle' | 'running' | 'watching'

let log: OutputChannel
let emitter: EventEmitter
let diagnosticCollection: DiagnosticCollection
let statusBarItem: StatusBarItem
let status: Status
let callback: any

class TemmeDocumentSymbolProvider implements DocumentSymbolProvider {
  public async provideDocumentSymbols(
    document: TextDocument,
    token: CancellationToken,
  ): Promise<SymbolInformation[]> {
    // TODO TemmeDocumentSymbolProvider
    return []
  }
}

/** 在用户进行编辑选择器的时候，该函数将会运行
 * 解析用户输入的 temme 选择器，并报告选择器语法错误 */
function detectAndReportTemmeGrammarError(document: TextDocument) {
  try {
    temmeParser.parse(document.getText())
    diagnosticCollection.delete(document.uri)
  } catch (e) {
    let start: Position
    let end: Position
    if (e.location != null && e.location.start != null && e.location.end != null) {
      start = new Position(e.location.start.line - 1, e.location.start.column - 1)
      const endLine = e.location.end.line - 1
      end = new Position(endLine, document.lineAt(endLine).text.length)
    } else {
      // 如果错误位置无法确定的话，就使用第一行
      start = new Position(0, 0)
      end = new Position(0, document.lineAt(0).text.length)
    }
    diagnosticCollection.set(document.uri, [new Diagnostic(new Range(start, end), e.message)])
  }
}

/** 从文档中挑选链接。
 * 如果文档中没有链接，则什么也不做
 * 如果文档中只有一个链接，则直接使用该链接
 * 如果文档中有多个链接，则弹出快速选择框让用户进行选择
 * */
async function pickLink(document: TextDocument) {
  const taggedLinks: { tag: string; link: string }[] = []

  const lineCount = document.lineCount
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const line = document.lineAt(lineIndex)
    const match = line.text.match(TAGGED_LINK_PATTERN)
    if (match) {
      taggedLinks.push({
        tag: match[1],
        link: match[2].trim(),
      })
    }
  }

  if (taggedLinks.length === 0) {
    window.showInformationMessage('No link is found in current file.')
    return
  } else if (taggedLinks.length === 1) {
    return taggedLinks[0].link
  } else {
    const options = taggedLinks.map(({ tag, link }) => `${tag} ${link}`)
    const result = await window.showQuickPick(options, { placeHolder: 'Choose an url:' })
    if (result) {
      return taggedLinks[options.indexOf(result)].link
    }
  }
}

async function downloadHtmlFromLink(url: string) {
  let isFileLink = false
  if (url.startsWith('file:///')) {
    url = url.replace('file:///', '')
    isFileLink = true
  }

  if (isFileLink) {
    return fs.readFileSync(url, 'utf8')
  } else {
    const response = await fetch(url)
    if (response.ok) {
      return await response.text()
    } else {
      throw new Error(`Cannot download html from ${url}`)
    }
  }
}

async function getLink(link?: string) {
  const editor = window.activeTextEditor
  if (editor == null) {
    window.showWarningMessage('No file opened.')
    return
  }
  const document = editor.document
  if (document.languageId !== 'temme') {
    window.showWarningMessage('Not a temme file.')
    return
  }
  if (link == null) {
    link = await pickLink(document)
  }
  return link
}

async function runSelector(link?: string) {
  link = await getLink(link)
  if (link == null) {
    return
  }
  const document = window.activeTextEditor!.document

  try {
    status = 'running'
    statusBarItem.text = status
    const html = await downloadHtmlFromLink(link)
    const result = temme(html, document.getText())
    const outputContent = JSON.stringify(result, null, 2)
    const outputFileName = path.resolve(document.uri.fsPath, '../', `${document.fileName}.json`)
    fs.writeFileSync(outputFileName, outputContent, 'utf8')

    const outputDocument = await workspace.openTextDocument(Uri.file(outputFileName))
    const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
    if (!visibleDocs.has(outputDocument)) {
      await window.showTextDocument(outputDocument, ViewColumn.Two)
    }
    await window.showInformationMessage('Success')
  } catch (e) {
    window.showErrorMessage(e.stack || e.message)
  } finally {
    status = 'idle'
    statusBarItem.text = status
  }
}

async function startWatch(link?: string) {
  stopWatch()
  const editor = window.activeTextEditor
  if (editor == null) {
    return
  }
  const temmeDocument = editor.document
  if (temmeDocument.languageId !== 'temme') {
    return
  }

  link = await getLink(link)
  if (link == null) {
    return
  }

  try {
    status = 'watching'
    statusBarItem.text = '$(zap) watching'
    statusBarItem.tooltip = 'Click to exit temme watch mode.'
    statusBarItem.command = 'temme.stopWatch'

    const html = await downloadHtmlFromLink(link)
    const $ = cheerio.load(html, { decodeEntities: false })

    const outputFileName = path.resolve(
      temmeDocument.uri.fsPath,
      '../',
      `${temmeDocument.fileName}.json`,
    )
    const outputDocument = await workspace.openTextDocument(Uri.file(outputFileName))
    const visibleDocs = new Set(window.visibleTextEditors.map(editor => editor.document))
    if (!visibleDocs.has(outputDocument)) {
      await window.showTextDocument(outputDocument, ViewColumn.Two)
    }

    async function onThisTemmeDocmentChange(changedLine: number) {
      try {
        const selector = temmeDocument.getText()
        const range = new Range(0, 0, outputDocument.lineCount, 0)
        const result = temme($, selector)
        const newText = JSON.stringify(result, null, 2)
        const edit = new WorkspaceEdit()
        edit.replace(outputDocument.uri, range, newText)
        await workspace.applyEdit(edit)
      } catch (e) {
        if (e.name !== 'SyntaxError') {
          log.appendLine(e.message)
          // TODO 错误不一定当前编辑的这一行 或第一行
          diagnosticCollection.set(temmeDocument.uri, [
            new Diagnostic(new Range(changedLine, 0, changedLine + 1, 0), e.message),
          ])
        }
      }
    }

    callback = async function({ document, contentChanges }: TextDocumentChangeEvent) {
      if (document === temmeDocument) {
        await onThisTemmeDocmentChange(contentChanges[0].range.start.line)
      }
    }

    emitter.addListener('did-change-text-document', callback)

    // 手动触发更新
    await onThisTemmeDocmentChange(0)
  } catch (e) {
    window.showErrorMessage(e.message)
    log.appendLine(e.stack || e.message)
  }
}

function stopWatch() {
  if (callback) {
    emitter.removeListener('did-change-text-document', callback)
    callback = null
    status = 'idle'
    statusBarItem.text = 'status'
  }
}

class TemmeCodeActionProvider implements CodeActionProvider {
  async provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
    token: CancellationToken,
  ) {
    const editor = window.activeTextEditor
    if (editor == null) {
      return null
    }
    const currentLineText = document.lineAt(editor.selection.start.line).text
    const match = currentLineText.match(TAGGED_LINK_PATTERN)
    if (match != null) {
      const tag = match[1]
      const link = match[2].trim()
      return [
        {
          title: `Run selector ${tag}`,
          command: 'temme.runSelector',
          arguments: [link],
        } as Command,
        {
          title: `Start watching ${tag}`,
          command: 'temme.startWatch',
          arguments: [link],
        },
      ]
    } else {
      return null
    }
  }
}

export function activate(ctx: ExtensionContext) {
  status = 'idle'
  log = window.createOutputChannel('temme')
  log.show(false)
  emitter = new EventEmitter()
  diagnosticCollection = languages.createDiagnosticCollection('temme')
  statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left)
  statusBarItem.text = 'idle'
  statusBarItem.show()

  ctx.subscriptions.push(
    commands.registerCommand('temme.runSelector', runSelector),
    commands.registerCommand('temme.startWatch', startWatch),
    commands.registerCommand('temme.stopWatch', stopWatch),
    languages.registerDocumentSymbolProvider(TEMME_MODE, new TemmeDocumentSymbolProvider()),
    languages.registerCodeActionsProvider(TEMME_MODE, new TemmeCodeActionProvider()),
    workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'temme') {
        emitter.emit('did-change-text-document', event)
        detectAndReportTemmeGrammarError(event.document)
      }
    }),
    // TODO 处理 window.onDidChangeActiveTextEditor
    diagnosticCollection,
    statusBarItem,
  )

  if (window.activeTextEditor && window.activeTextEditor.document.languageId === 'temme') {
    detectAndReportTemmeGrammarError(window.activeTextEditor.document)
  }
}
